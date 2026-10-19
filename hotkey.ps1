# ============================================================
#  AI 截图助手 - 全局热键守护
#  按热键 → 全屏遮罩 → 拖拽框选 → 保存 PNG（不跳转网页）
# ============================================================
param([switch]$Quiet)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$iniPath = Join-Path $Root 'hotkey.ini'
$logPath = Join-Path $Root 'hotkey-debug.log'
$outDir  = Join-Path $Root 'captures'

function Log($msg) {
    try {
        [System.IO.File]::AppendAllText($logPath,
            ("[{0:HH:mm:ss.fff}] {1}`r`n" -f (Get-Date), $msg),
            [System.Text.Encoding]::UTF8)
    } catch { }
}
Log "=== 启动 ==="

# ---------- 配置 ----------
$cfg = @{
    Hotkey   = 'Ctrl+Alt+S'
    Url      = 'http://127.0.0.1:8787/ai-capture-assistant.html'
    Mode     = 'region'
    CopyImage= $false
    AutoOpen = $false
    AutoSend = $true
}
if (Test-Path $iniPath) {
    foreach ($line in (Get-Content $iniPath -Encoding UTF8)) {
        if ($line -match '^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$') {
            $k = $Matches[1].ToLower(); $v = $Matches[2].Trim()
            switch ($k) {
                'hotkey'    { $cfg.Hotkey = $v }
                'url'       { $cfg.Url = $v }
                'mode'      { $cfg.Mode = $v }
                'copyimage' { $cfg.CopyImage = ($v -match '^(1|true|yes)$') }
                'autoopen'  { $cfg.AutoOpen  = ($v -match '^(1|true|yes)$') }
                'autosend'  { $cfg.AutoSend  = ($v -match '^(1|true|yes)$') }
            }
        }
    }
}
Log "配置: $($cfg.Hotkey) / mode=$($cfg.Mode) / copy=$($cfg.CopyImage)"

# ---------- 热键解析 ----------
function ParseHotkey($spec) {
    $mod = 0; $vk = 0
    foreach ($p in ($spec -split '\+')) {
        $t = $p.Trim()
        switch -Regex ($t) {
            '^(Ctrl|Control)$' { $mod = $mod -bor 0x0002; continue }
            '^Alt$'            { $mod = $mod -bor 0x0001; continue }
            '^Shift$'          { $mod = $mod -bor 0x0004; continue }
            '^(Win|Meta)$'     { $mod = $mod -bor 0x0008; continue }
            default {
                if ($t.Length -eq 1) { $vk = [int][char]([char]::ToUpper($t[0])) }
                elseif ($t -match '^F(\d{1,2})$') { $vk = 0x70 + [int]$Matches[1] - 1 }
                elseif ($t -match '^\d$') { $vk = 0x30 + [int]$t }
            }
        }
    }
    return @{ Mod = $mod; Key = $vk }
}
$hk = ParseHotkey $cfg.Hotkey
if ($hk.Key -eq 0) {
    [System.Windows.Forms.MessageBox]::Show("hotkey.ini 中热键 '$($cfg.Hotkey)' 无法解析", "AI 截图助手")
    exit 1
}

# 把实际生效的热键写回 hotkey.ini（保留注释；用无 BOM UTF-8，避免下次读取乱码）
function Save-Hotkey([string]$spec) {
    try {
        if (-not (Test-Path $iniPath)) { return }
        $content = [System.IO.File]::ReadAllText($iniPath, [System.Text.Encoding]::UTF8)
        if ($content -match '(?im)^\s*Hotkey\s*=.*$') {
            $content = [regex]::Replace($content, '(?im)^\s*Hotkey\s*=.*$', ('Hotkey = ' + $spec))
        } else {
            $content = $content.TrimEnd() + "`r`nHotkey = $spec`r`n"
        }
        [System.IO.File]::WriteAllText($iniPath, $content, (New-Object System.Text.UTF8Encoding($false)))
        Log ("配置已更新为 " + $spec)
    } catch {
        Log ("写入配置失败: " + $_.Exception.Message)
    }
}

# ---------- 截图与遮罩 ----------
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class SC {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
    public static int W { get { return GetSystemMetrics(0); } }
    public static int H { get { return GetSystemMetrics(1); } }

    public static Bitmap GrabScreen() {
        var bmp = new Bitmap(W, H);
        using (var g = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(0, 0, 0, 0, new Size(W, H));
        }
        return bmp;
    }

    public static Bitmap Crop(Bitmap src, Rectangle r) {
        var outBmp = new Bitmap(r.Width, r.Height);
        using (var g = Graphics.FromImage(outBmp)) {
            g.DrawImage(src, new Rectangle(0, 0, r.Width, r.Height), r, GraphicsUnit.Pixel);
        }
        return outBmp;
    }

    public static string Save(Bitmap bmp, string dir) {
        if (!System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);
        string name = "截图_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".png";
        string path = System.IO.Path.Combine(dir, name);
        bmp.Save(path, ImageFormat.Png);
        return path;
    }
}

// 全屏遮罩：显示截图，拖拽选区
public class Overlay : Form {
    public Bitmap Shot;
    public Rectangle Sel = Rectangle.Empty;
    public bool Ok = false;

    Point _start, _last;
    bool _drag;

    public Overlay() {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(0, 0, SC.W, SC.H);
        TopMost = true;
        ShowInTaskbar = false;
        Cursor = Cursors.Cross;
        DoubleBuffered = true;
        KeyPreview = true;
        BackColor = Color.Black;
    }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
        if (Shot != null) g.DrawImageUnscaled(Shot, 0, 0);

        using (var dim = new SolidBrush(Color.FromArgb(130, 0, 0, 0)))
            g.FillRectangle(dim, ClientRectangle);

        var r = _drag ? SelFromDrag() : Sel;
        if (r.Width > 0 && r.Height > 0) {
            var st = g.Save();
            g.SetClip(r);
            if (Shot != null) g.DrawImageUnscaled(Shot, 0, 0);
            g.Restore(st);

            using (var pen = new Pen(Color.FromArgb(255, 60, 150, 255), 2))
                g.DrawRectangle(pen, r);

            string t = r.Width + " × " + r.Height;
            using (var f = new Font("Consolas", 11))
            using (var bg = new SolidBrush(Color.FromArgb(220, 25, 25, 25)))
            using (var fg = new SolidBrush(Color.White)) {
                var sz = g.MeasureString(t, f);
                int bx = r.X, by = r.Y - (int)sz.Height - 10;
                if (by < 0) by = r.Bottom + 6;
                g.FillRectangle(bg, bx, by, sz.Width + 12, sz.Height + 6);
                g.DrawString(t, f, fg, bx + 6, by + 3);
            }
        } else {
            string hint = "拖动鼠标框选    Esc 取消    Enter 整屏";
            using (var f = new Font("Microsoft YaHei", 13))
            using (var bg = new SolidBrush(Color.FromArgb(210, 20, 20, 20)))
            using (var fg = new SolidBrush(Color.White)) {
                var sz = g.MeasureString(hint, f);
                int bx = (ClientSize.Width - (int)sz.Width) / 2;
                g.FillRectangle(bg, bx - 14, 36, sz.Width + 28, sz.Height + 14);
                g.DrawString(hint, f, fg, bx, 43);
            }
        }
    }

    Rectangle SelFromDrag() {
        int x = Math.Min(_start.X, _last.X), y = Math.Min(_start.Y, _last.Y);
        return new Rectangle(x, y, Math.Abs(_last.X - _start.X), Math.Abs(_last.Y - _start.Y));
    }

    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left) { _start = _last = e.Location; _drag = true; Invalidate(); }
        base.OnMouseDown(e);
    }
    protected override void OnMouseMove(MouseEventArgs e) {
        if (_drag) { _last = e.Location; Invalidate(); }
        base.OnMouseMove(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        if (_drag && e.Button == MouseButtons.Left) {
            _drag = false;
            var r = SelFromDrag();
            if (r.Width > 4 && r.Height > 4) { Sel = r; Ok = true; Close(); }
            else { Sel = Rectangle.Empty; Invalidate(); }
        }
        base.OnMouseUp(e);
    }
    protected override void OnKeyDown(KeyEventArgs e) {
        if (e.KeyCode == Keys.Escape) { Ok = false; Close(); }
        else if (e.KeyCode == Keys.Enter) { Sel = new Rectangle(0, 0, SC.W, SC.H); Ok = true; Close(); }
        base.OnKeyDown(e);
    }
}

// 主窗体：只负责收热键
public class HotForm : Form {
    public const int WM_HOTKEY = 0x0312;
    public event EventHandler Hot;
    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_HOTKEY) {
            try { if (Hot != null) Hot(this, EventArgs.Empty); } catch { }
            return;
        }
        base.WndProc(ref m);
    }
}
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

[SC]::SetProcessDPIAware() | Out-Null

# ---------- 截图动作 ----------
function Invoke-Capture {
    Log "--- 开始截图 ---"
    try {
        $shot = [SC]::GrabScreen()
        Log ("抓屏完成 " + $shot.Width + "x" + $shot.Height)

        $rect = $null
        if ($cfg.Mode -eq 'full') {
            $rect = New-Object System.Drawing.Rectangle(0, 0, $shot.Width, $shot.Height)
        } else {
            $ov = New-Object Overlay
            $ov.Shot = $shot
            $ov.ShowDialog() | Out-Null
            if (-not $ov.Ok) {
                $shot.Dispose()
                Log "用户取消"
                return
            }
            $rect = $ov.Sel
            Log ("选区 " + $rect.Width + "x" + $rect.Height + " @ " + $rect.X + "," + $rect.Y)
        }

        $crop = [SC]::Crop($shot, $rect)
        $shot.Dispose()

        $path = [SC]::Save($crop, $outDir)
        Log ("已保存: " + $path)

        if ($cfg.CopyImage) {
            try { [System.Windows.Forms.Clipboard]::SetImage($crop); Log "已复制到剪贴板" }
            catch { Log ("剪贴板失败: " + $_.Exception.Message) }
        }

        # 把截图投递给已打开的网页：网页会轮询 /api/shot 取走并自动翻译。
        # 这样"按快捷键截图 → 网页出译文"就串起来了，不用手动拖图片。
        # 网页没开也没关系，投递失败只写日志，不影响已保存的文件。
        if ($cfg.AutoSend) {
            try {
                $ms = New-Object System.IO.MemoryStream
                $crop.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $b64 = [Convert]::ToBase64String($ms.ToArray())
                $ms.Dispose()
                $body = '{"image":"data:image/png;base64,' + $b64 + '"}'
                $base = $cfg.Url -replace '/[^/]*$', ''      # 取到 http://host:port
                $api = $base + '/api/shot'
                Invoke-RestMethod -Uri $api -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 10 | Out-Null
                Log "已投递给网页 ($api)"
            } catch {
                Log ("投递网页失败（网页可能没开）: " + $_.Exception.Message)
            }
        }

        # 可选：截图后打开网页做 OCR/翻译
        if ($cfg.AutoOpen) {
            Start-Process $cfg.Url
            Log "已打开助手页面"
        }

        $crop.Dispose()
        Log "--- 完成 ---"
    } catch {
        Log ("截图异常: " + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show("截图失败:`n" + $_.Exception.Message, "AI 截图助手")
    }
}
# ---------- 托盘 ----------
$notify = New-Object System.Windows.Forms.NotifyIcon
try { $notify.Icon = [System.Drawing.SystemIcons]::Application } catch { }
$notify.Text = "AI 截图助手 - $($cfg.Hotkey)"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$mShot = $menu.Items.Add("立即截图")
$mOpen = $menu.Items.Add("打开截图文件夹")
$mCfg  = $menu.Items.Add("编辑配置")
$mExit = $menu.Items.Add("退出")
$notify.ContextMenuStrip = $menu

$mShot.add_Click({ Invoke-Capture })
$mOpen.add_Click({ if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }; Start-Process explorer.exe $outDir })
$mCfg.add_Click({ Start-Process notepad.exe $iniPath })
$mExit.add_Click({ $notify.Visible = $false; $notify.Dispose(); [System.Windows.Forms.Application]::Exit() })

# ---------- 窗体与热键 ----------
$form = New-Object HotForm
$form.ShowInTaskbar = $false
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-32000, -32000)
$form.Width = 1; $form.Height = 1
$form.add_Hot({ Invoke-Capture })

# 注册时机放在 Shown（此时句柄已创建完成）。旧版在 HandleCreated 里直接
# $form.Close()，会抛 "执行 CreateHandle() 时无法调用值 Close()"。
$script:hkRegistered = $false
$form.add_Shown({
    if ($script:hkRegistered) { return }
    $script:hkRegistered = $true

    $wanted = $cfg.Hotkey
    $ok = [SC]::RegisterHotKey($form.Handle, 0x534E41, [uint32]$hk.Mod, [uint32]$hk.Key)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($ok) {
        Log ("热键注册成功 " + $cfg.Hotkey)
        $notify.Text = "AI 截图助手 - $($cfg.Hotkey)"
        return
    }

    Log ("热键注册失败 err=" + $err + "，尝试备选组合")
    $tried = @($wanted)
    foreach ($candidate in @('Ctrl+Alt+A', 'Ctrl+Shift+F9', 'Ctrl+Alt+Shift+S')) {
        if ($tried -contains $candidate) { continue }
        $tried += $candidate
        $h = ParseHotkey $candidate
        if ($h.Key -eq 0) { continue }
        if ([SC]::RegisterHotKey($form.Handle, 0x534E41, [uint32]$h.Mod, [uint32]$h.Key)) {
            $hk = $h
            $cfg.Hotkey = $candidate
            Save-Hotkey $candidate
            $notify.Text = "AI 截图助手 - $candidate"
            Log ("已改用备选热键 " + $candidate)
            try {
                $notify.ShowBalloonTip(4000, "AI 截图助手", "热键 $wanted 已被占用，已自动改用 $candidate", [System.Windows.Forms.ToolTipIcon]::Info)
            } catch { }
            return
        }
    }

    Log "所有备选热键都注册失败"
    $msg = "热键 $wanted 已被其他程序占用，备选组合也不可用。`n`n请修改 hotkey.ini 里的 Hotkey 后重新启动。"
    [System.Windows.Forms.MessageBox]::Show($msg, "AI 截图助手") | Out-Null
    try { $notify.Visible = $false; $notify.Dispose() } catch { }
    $form.Close()
})
$form.add_FormClosing({
    try { [SC]::UnregisterHotKey($form.Handle, 0x534E41) | Out-Null } catch { }
})

if (-not $Quiet) {
    Write-Host "============================================"
    Write-Host "  AI Screenshot Helper"
    Write-Host "============================================"
    Write-Host ""
    Write-Host "  Hotkey  : $($cfg.Hotkey)  ->  drag to select"
    Write-Host "  Save to : $outDir"
    Write-Host "  Mode    : $($cfg.Mode)"
    Write-Host ""
    Write-Host "  No browser window will open."
    Write-Host "  Close this window to exit."
    Write-Host ""
}

[System.Windows.Forms.Application]::Run($form)
Log "=== 退出 ==="