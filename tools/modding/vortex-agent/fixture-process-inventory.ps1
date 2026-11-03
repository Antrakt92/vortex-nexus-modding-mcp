# Read-only: no WMI, command lines, windows, messages, or process termination.
$ErrorActionPreference = 'Stop'
if (-not ('FixtureProcessInventory.NativeInventory' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace FixtureProcessInventory {
  public sealed class ProcessIdentity {
    public uint ProcessId;
    public uint ParentProcessId;
    public string ExecutablePath;
    public string StartTicks;
    public bool IsMain;
  }
  public sealed class Inventory {
    public string Schema = "fixture-process-inventory/1";
    public bool Complete = true;
    public int Count;
    public ProcessIdentity[] Processes;
  }
  public static class NativeInventory {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Entry {
      public uint dwSize, cntUsage, th32ProcessID;
      public UIntPtr th32DefaultHeapID;
      public uint th32ModuleID, cntThreads, th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool First(SafeFileHandle snapshot, ref Entry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool Next(SafeFileHandle snapshot, ref Entry entry);
    static Dictionary<uint, uint> Cohort() {
      var result = new Dictionary<uint, uint>();
      using (var snapshot = CreateToolhelp32Snapshot(2, 0)) {
        if (snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Process snapshot unavailable");
        var entry = new Entry { dwSize = (uint)Marshal.SizeOf(typeof(Entry)) };
        bool available = First(snapshot, ref entry);
        int count = 0;
        while (available) {
          if (++count > 65536) throw new InvalidOperationException("Process snapshot limit");
          if (String.Equals(entry.szExeFile, "Vortex.exe", StringComparison.OrdinalIgnoreCase))
            result.Add(entry.th32ProcessID, entry.th32ParentProcessID);
          available = Next(snapshot, ref entry);
        }
        if (Marshal.GetLastWin32Error() != 18) throw new InvalidOperationException("Incomplete process snapshot");
      }
      return result;
    }
    public static Inventory Read() {
      const string expected = @"C:\Program Files\Vortex\Vortex.exe";
      var first = Cohort();
      if (first.Count == 0) throw new InvalidOperationException("No Vortex cohort observed");
      var held = new List<Process>();
      var rows = new List<ProcessIdentity>();
      try {
        foreach (var pair in first) {
          var process = Process.GetProcessById(checked((int)pair.Key)); held.Add(process);
          var handle = process.Handle; // Retain native generation until all validation finishes.
          if (process.HasExited) throw new InvalidOperationException("Vortex cohort changed");
          string executable = process.MainModule.FileName;
          if (!String.Equals(executable, expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Unexpected Vortex executable");
          rows.Add(new ProcessIdentity { ProcessId = pair.Key, ParentProcessId = pair.Value,
            ExecutablePath = executable, StartTicks = process.StartTime.ToUniversalTime().Ticks.ToString(),
            IsMain = !first.ContainsKey(pair.Value) });
        }
        var second = Cohort();
        if (first.Count != second.Count) throw new InvalidOperationException("Vortex cohort changed");
        foreach (var pair in first) {
          uint parent;
          if (!second.TryGetValue(pair.Key, out parent) || parent != pair.Value)
            throw new InvalidOperationException("Vortex parent cohort changed");
        }
        // Independently enumerate .NET cohort; do not accept disagreement.
        var dotnet = Process.GetProcessesByName("Vortex");
        try {
          if (dotnet.Length != first.Count) throw new InvalidOperationException("Vortex enumeration disagreement");
          foreach (var process in dotnet) if (!first.ContainsKey(checked((uint)process.Id)))
            throw new InvalidOperationException("Vortex enumeration disagreement");
        } finally { foreach (var process in dotnet) process.Dispose(); }
        uint main = 0; int mains = 0;
        foreach (var row in rows) {
          if (row.IsMain) { main = row.ProcessId; mains++; }
          var process = held.Find(p => p.Id == row.ProcessId);
          process.Refresh();
          if (process.HasExited || process.StartTime.ToUniversalTime().Ticks.ToString() != row.StartTicks
            || !String.Equals(process.MainModule.FileName, row.ExecutablePath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Vortex generation changed");
          ProcessIdentity parent = rows.Find(p => p.ProcessId == row.ParentProcessId);
          if (parent != null && Int64.Parse(parent.StartTicks) > Int64.Parse(row.StartTicks))
            throw new InvalidOperationException("Vortex parent generation changed");
        }
        if (mains < 1) throw new InvalidOperationException("Vortex root unavailable");
        rows.Sort((a, b) => a.ProcessId.CompareTo(b.ProcessId));
        return new Inventory { Count = rows.Count, Processes = rows.ToArray() };
      } finally { foreach (var process in held) process.Dispose(); }
    }
  }
}
'@
}
# Only emit after the complete snapshot and independent generation checks succeed.
$inventory = [FixtureProcessInventory.NativeInventory]::Read()
Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$inventory | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 5
