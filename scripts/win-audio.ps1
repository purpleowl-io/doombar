# Doombar audio helper. Fallback when the koffi COM path is unavailable.
# Reads one JSON command per line on stdin, writes one JSON result per line.
#   {"cmd":"get"}               -> {"ok":true,"volume":0.42,"mute":false,"device":"Speakers (Realtek)"}
#   {"cmd":"set","volume":0.5}  -> {"ok":true}
#   {"cmd":"mute","mute":true}  -> {"ok":true}
#   {"cmd":"key","vk":179}      -> {"ok":true}   (media/volume keys via keybd_event)
#   {"cmd":"meter"}             -> {"ok":true,"peak":0.31}          (IAudioMeterInformation, 0..1)
#   {"cmd":"list"}              -> {"ok":true,"devices":[{"id":"{0.0.0...}","name":"Speakers","default":true}]}
#   {"cmd":"setDefault","id":"{0.0.0...}"} -> {"ok":true}   (IPolicyConfig, all three roles)
#   {"cmd":"nowPlaying"}        -> {"ok":true,"media":{"title":"...","artist":"...","status":"Playing","app":"Spotify.exe","hasArt":true}}
#   {"cmd":"art"}               -> {"ok":true,"art":{"type":"image/jpeg","data":"<base64>"}}   (or art null)
$ErrorActionPreference = 'Stop'
# Node reads our stdout as UTF-8; the console default (OEM code page) mangles names like "Söderqvist".
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PROPVARIANT {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr pointerValue;
  [FieldOffset(16)] public IntPtr reserved;
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out uint count);
  int GetAt(uint index, out PROPERTYKEY key);
  int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
  int Commit();
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr pNotify);
  int UnregisterControlChangeNotify(IntPtr pNotify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float levelDb, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int GetMasterVolumeLevel(out float levelDb);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float levelDb, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float levelDb);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute(out bool mute);
  int GetVolumeStepInfo(out uint step, out uint stepCount);
  int VolumeStepUp(ref Guid ctx);
  int VolumeStepDown(ref Guid ctx);
  int QueryHardwareSupport(out uint mask);
  int GetVolumeRange(out float minDb, out float maxDb, out float incDb);
}

[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out uint count);
  int GetChannelsPeakValues(uint count, IntPtr peaks);
  int QueryHardwareSupport(out uint mask);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int access, out IPropertyStore store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
  int GetCount(out uint count);
  int Item(uint index, out IMMDevice device);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

// Undocumented but stable since Vista; what every "set default audio device" tool uses.
[Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  int GetMixFormat(string id, IntPtr fmt);
  int GetDeviceFormat(string id, int def, IntPtr fmt);
  int ResetDeviceFormat(string id);
  int SetDeviceFormat(string id, IntPtr a, IntPtr b);
  int GetProcessingPeriod(string id, int def, IntPtr a, IntPtr b);
  int SetProcessingPeriod(string id, IntPtr p);
  int GetShareMode(string id, IntPtr mode);
  int SetShareMode(string id, IntPtr mode);
  int GetPropertyValue(string id, int store, ref PROPERTYKEY key, out PROPVARIANT value);
  int SetPropertyValue(string id, int store, ref PROPERTYKEY key, ref PROPVARIANT value);
  int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  int SetEndpointVisibility(string id, int visible);
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
public class PolicyConfigComObject { }

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public static class DoombarAudio {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);

  static IMMDevice Device() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out d));
    return d;
  }
  static IAudioEndpointVolume Volume(IMMDevice d) {
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float GetVolume() { float v; Marshal.ThrowExceptionForHR(Volume(Device()).GetMasterVolumeLevelScalar(out v)); return v; }
  public static void SetVolume(float v) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Volume(Device()).SetMasterVolumeLevelScalar(v, ref g)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Volume(Device()).GetMute(out m)); return m; }
  public static void SetMute(bool m) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Volume(Device()).SetMute(m, ref g)); }
  public static string DeviceName() {
    IPropertyStore ps; Marshal.ThrowExceptionForHR(Device().OpenPropertyStore(0 /*STGM_READ*/, out ps));
    var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    PROPVARIANT pv; Marshal.ThrowExceptionForHR(ps.GetValue(ref key, out pv));
    string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.pointerValue) : "";
    PropVariantClear(ref pv);
    return name;
  }
  public static void Key(byte vk) { keybd_event(vk, 0, 1, UIntPtr.Zero); keybd_event(vk, 0, 3, UIntPtr.Zero); }

  static IAudioMeterInformation meter; static string meterDevice;
  public static float Peak() {
    var d = Device(); string id; d.GetId(out id);
    if (meter == null || meterDevice != id) {
      Guid iid = typeof(IAudioMeterInformation).GUID; object o;
      Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
      meter = (IAudioMeterInformation)o; meterDevice = id;
    }
    float p; Marshal.ThrowExceptionForHR(meter.GetPeakValue(out p)); return p;
  }

  static string Name(IMMDevice d) {
    IPropertyStore ps; Marshal.ThrowExceptionForHR(d.OpenPropertyStore(0, out ps));
    var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    PROPVARIANT pv; Marshal.ThrowExceptionForHR(ps.GetValue(ref key, out pv));
    string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.pointerValue) : "";
    PropVariantClear(ref pv);
    return name;
  }
  // Active render endpoints: id, name, whether it is the current default.
  public static object[] List() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDeviceCollection col; Marshal.ThrowExceptionForHR(e.EnumAudioEndpoints(0 /*eRender*/, 1 /*DEVICE_STATE_ACTIVE*/, out col));
    string defId; Device().GetId(out defId);
    uint n; col.GetCount(out n);
    var out_ = new object[n];
    for (uint i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d); string id; d.GetId(out id);
      out_[i] = new System.Collections.Hashtable { { "id", id }, { "name", Name(d) }, { "default", id == defId } };
    }
    return out_;
  }
  public static void SetDefault(string id) {
    var pc = (IPolicyConfig)(new PolicyConfigComObject());
    for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(pc.SetDefaultEndpoint(id, role)); // eConsole, eMultimedia, eCommunications
    meter = null;
  }
}
"@

# --- Now playing via WinRT GlobalSystemMediaTransportControlsSessionManager (Windows 10 1809+).
$script:mediaOk = $true
$script:mediaMgr = $null
try {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
} catch { $script:mediaOk = $false; [Console]::Error.WriteLine("now-playing unavailable: $($_.Exception.Message)") }

function Await($op, $type) {
  $task = $script:asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(2000)) { throw 'WinRT call timed out' }
  $task.Result
}
function NowPlaying {
  if (-not $script:mediaOk) { return $null }
  if ($null -eq $script:mediaMgr) {
    $script:mediaMgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  $s = $script:mediaMgr.GetCurrentSession()
  if ($null -eq $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $pb = $s.GetPlaybackInfo()
  @{ title = [string]$p.Title; artist = [string]$p.Artist; album = [string]$p.AlbumTitle; status = [string]$pb.PlaybackStatus; app = [string]$s.SourceAppUserModelId; hasArt = ($null -ne $p.Thumbnail) }
}

# Album art of the current session as base64 (Apple Music gives an 800x800 JPEG).
# PowerShell 5.1 cannot pass the stream's __ComObject to DataReader or to
# AsStreamForRead as written, so the extension method is invoked by reflection.
function NowPlayingArt {
  if (-not $script:mediaOk -or $null -eq $script:mediaMgr) { return $null }
  $s = $script:mediaMgr.GetCurrentSession()
  if ($null -eq $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if ($null -eq $p.Thumbnail) { return $null }
  if ($null -eq $script:asStreamForRead) {
    $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $script:asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
  }
  $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $ns = $script:asStreamForRead.Invoke($null, @($st))
  try { $ms = New-Object System.IO.MemoryStream; $ns.CopyTo($ms); $b = $ms.ToArray() } finally { $ns.Dispose() }
  if ($b.Length -eq 0 -or $b.Length -gt 4MB) { return $null }
  $type = if ($b[0] -eq 0x89 -and $b[1] -eq 0x50) { 'image/png' } else { 'image/jpeg' }
  @{ type = $type; data = [Convert]::ToBase64String($b) }
}

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

Emit @{ ok = $true; ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.cmd) {
      'get'  { Emit @{ ok = $true; volume = [DoombarAudio]::GetVolume(); mute = [DoombarAudio]::GetMute(); device = [DoombarAudio]::DeviceName() } }
      'set'  { [DoombarAudio]::SetVolume([float]$c.volume); Emit @{ ok = $true } }
      'mute' { [DoombarAudio]::SetMute([bool]$c.mute); Emit @{ ok = $true } }
      'key'  { [DoombarAudio]::Key([byte]$c.vk); Emit @{ ok = $true } }
      'meter' { Emit @{ ok = $true; peak = [DoombarAudio]::Peak() } }
      'list' { Emit @{ ok = $true; devices = @([DoombarAudio]::List()) } }
      'setDefault' { [DoombarAudio]::SetDefault([string]$c.id); Emit @{ ok = $true } }
      'nowPlaying' {
        $m = $null
        try { $m = NowPlaying } catch { $script:mediaMgr = $null; [Console]::Error.WriteLine("now-playing: $($_.Exception.Message)") }
        Emit @{ ok = $true; media = $m }
      }
      'art' {
        $a = $null
        try { $a = NowPlayingArt } catch { [Console]::Error.WriteLine("art: $($_.Exception.Message)") }
        Emit @{ ok = $true; art = $a }
      }
      'quit' { Emit @{ ok = $true }; exit 0 }
      default { Emit @{ ok = $false; error = "unknown cmd $($c.cmd)" } }
    }
  } catch {
    Emit @{ ok = $false; error = $_.Exception.Message }
  }
}
