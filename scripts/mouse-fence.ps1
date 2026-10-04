# Doombar mouse fence. Keeps the physical mouse off the touch strip.
# A WH_MOUSE_LL hook drops mouse moves that would land inside the fenced rect and
# parks the cursor on the nearest point of a neighbouring monitor instead, so it
# slides along the edge. Touch/pen-promoted moves (dwExtraInfo signature
# 0xFF5157xx) pass through, so tapping the strip still works.
# stdin, one line each:  "left top right bottom" (physical px, right/bottom exclusive)  |  "off"
# stdin EOF exits, so the fence dies with the app.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class MouseFence {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  const int WH_MOUSE_LL = 14, WM_MOUSEMOVE = 0x200;
  static readonly HookProc proc = Hook; // held so the GC keeps the callback alive
  static int[] rect;                    // swapped whole, read once per event
  static POINT lastOutside;

  public static void SetRect(int l, int t, int r, int b) { Volatile.Write(ref rect, new[] { l, t, r, b }); }
  public static void Off() { Volatile.Write(ref rect, null); }

  public static void Start() {
    var ready = new ManualResetEvent(false);
    string err = null;
    var th = new Thread(() => {
      // Per-monitor v2, so hook points, MonitorFromPoint and SetCursorPos all use physical pixels.
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      if (SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle("user32.dll"), 0) == IntPtr.Zero)
        err = "SetWindowsHookEx failed: " + Marshal.GetLastWin32Error();
      ready.Set();
      if (err != null) return;
      MSG m;
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    });
    th.IsBackground = true;
    th.Start();
    ready.WaitOne();
    if (err != null) throw new Exception(err);
  }

  static bool Inside(POINT p, int[] r) { return p.x >= r[0] && p.x < r[2] && p.y >= r[1] && p.y < r[3]; }
  static bool OnMonitor(POINT p) { return MonitorFromPoint(p, 0) != IntPtr.Zero; }

  static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0 && (int)wParam == WM_MOUSEMOVE) {
      var r = Volatile.Read(ref rect);
      var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
      bool touch = ((long)m.extra & 0xFFFFFF00L) == 0xFF515700L;
      if (r != null && !touch) {
        if (!Inside(m.pt, r)) { lastOutside = m.pt; }
        else {
          // Nearest point just outside the rect that is on another monitor.
          var c = new POINT[4];
          c[0].x = m.pt.x; c[0].y = r[1] - 1;
          c[1].x = m.pt.x; c[1].y = r[3];
          c[2].x = r[0] - 1; c[2].y = m.pt.y;
          c[3].x = r[2]; c[3].y = m.pt.y;
          POINT to = lastOutside; long best = long.MaxValue;
          foreach (var p in c) {
            long d = (long)(p.x - m.pt.x) * (p.x - m.pt.x) + (long)(p.y - m.pt.y) * (p.y - m.pt.y);
            if (d < best && OnMonitor(p)) { best = d; to = p; }
          }
          lastOutside = to;
          SetCursorPos(to.x, to.y);
          return new IntPtr(1);
        }
      }
    }
    return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
  }
}
"@

try {
  [MouseFence]::Start()
} catch {
  [Console]::Out.WriteLine("error $($_.Exception.Message)")
  exit 1
}
[Console]::Out.WriteLine('ready')

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim() -split '\s+'
  if ($p[0] -eq 'off') { [MouseFence]::Off(); continue }
  if ($p.Count -eq 4) { [MouseFence]::SetRect([int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3]) }
}
