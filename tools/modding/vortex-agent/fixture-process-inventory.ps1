# Read-only: no WMI, command lines, windows, messages, or process termination.
param([switch]$AllowEmpty, [uint32]$ExpectedMainPid = 0)
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
    public sealed class OwnedCohortChanged : Exception { }
    static void VerifyOwnedCohort(Dictionary<uint, uint> cohort, uint expectedMainPid) {
      if (expectedMainPid == 0) return;
      foreach (uint id in cohort.Keys) {
        uint current = id, parent;
        var visited = new HashSet<uint>();
        while (current != expectedMainPid) {
          if (!visited.Add(current) || !cohort.TryGetValue(current, out parent))
            throw new InvalidOperationException("Unexpected Vortex cohort root");
          current = parent;
        }
      }
      if (cohort.ContainsKey(expectedMainPid) && cohort.ContainsKey(cohort[expectedMainPid]))
        throw new InvalidOperationException("Unexpected fixture parent");
    }
    static bool SameCohort(Dictionary<uint, uint> first, Dictionary<uint, uint> second) {
      if (first.Count != second.Count) return false;
      foreach (var pair in first) {
        uint parent;
        if (!second.TryGetValue(pair.Key, out parent) || parent != pair.Value) return false;
      }
      return true;
    }
    static void RequireCohort(Dictionary<uint, uint> first, uint expectedMainPid) {
      var current = Cohort();
      VerifyOwnedCohort(current, expectedMainPid);
      if (SameCohort(first, current)) return;
      if (expectedMainPid != 0) throw new OwnedCohortChanged();
      throw new InvalidOperationException("Vortex cohort changed");
    }
    static void VerifyProcessPresent(Process process, Dictionary<uint, uint> first, uint expectedMainPid) {
      if (!process.HasExited) return;
      RequireCohort(first, expectedMainPid);
      throw new InvalidOperationException("Vortex process exited");
    }
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
    public static Inventory Read(bool allowEmpty, uint expectedMainPid) {
      const string expected = @"C:\Program Files\Vortex\Vortex.exe";
      var first = Cohort();
      VerifyOwnedCohort(first, expectedMainPid);
      if (first.Count == 0 && !allowEmpty) throw new InvalidOperationException("No Vortex cohort observed");
      var held = new List<Process>();
      var rows = new List<ProcessIdentity>();
      try {
        foreach (var pair in first) {
          Process process;
          string executable, startTicks;
          try {
            process = Process.GetProcessById(checked((int)pair.Key)); held.Add(process);
            var handle = process.Handle; // Retain native generation until all validation finishes.
            VerifyProcessPresent(process, first, expectedMainPid);
            executable = process.MainModule.FileName;
            startTicks = process.StartTime.ToUniversalTime().Ticks.ToString();
          } catch (Exception error) {
            // A failed open/read by itself provides no exit proof.
            if (expectedMainPid != 0 && (error is ArgumentException || error is InvalidOperationException || error is Win32Exception)) {
              var current = Cohort();
              VerifyOwnedCohort(current, expectedMainPid);
              if (!current.ContainsKey(pair.Key)) throw new OwnedCohortChanged();
            }
            throw;
          }
          if (!String.Equals(executable, expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Unexpected Vortex executable");
          rows.Add(new ProcessIdentity { ProcessId = pair.Key, ParentProcessId = pair.Value,
            ExecutablePath = executable, StartTicks = startTicks, IsMain = !first.ContainsKey(pair.Value) });
        }
        RequireCohort(first, expectedMainPid);
        // Independently enumerate .NET cohort; do not accept disagreement.
        var dotnet = Process.GetProcessesByName("Vortex");
        try {
          var dotnetIds = new HashSet<uint>();
          foreach (var process in dotnet) dotnetIds.Add(checked((uint)process.Id));
          if (!dotnetIds.SetEquals(first.Keys)) {
            if (expectedMainPid != 0) {
              var current = Cohort();
              VerifyOwnedCohort(current, expectedMainPid);
              bool known = true;
              foreach (var id in dotnetIds) if (!first.ContainsKey(id) && !current.ContainsKey(id)) known = false;
              if (known && !SameCohort(first, current)) throw new OwnedCohortChanged();
            }
            throw new InvalidOperationException("Vortex enumeration disagreement");
          }
        } finally { foreach (var process in dotnet) process.Dispose(); }
        uint main = 0; int mains = 0;
        foreach (var row in rows) {
          if (row.IsMain) { main = row.ProcessId; mains++; }
          var process = held.Find(p => p.Id == row.ProcessId);
          process.Refresh();
          try {
            VerifyProcessPresent(process, first, expectedMainPid);
            if (process.StartTime.ToUniversalTime().Ticks.ToString() != row.StartTicks
              || !String.Equals(process.MainModule.FileName, row.ExecutablePath, StringComparison.OrdinalIgnoreCase))
              throw new InvalidOperationException("Vortex generation changed");
          } catch (Win32Exception) {
            RequireCohort(first, expectedMainPid);
            throw;
          }
          ProcessIdentity parent = rows.Find(p => p.ProcessId == row.ParentProcessId);
          if (parent != null && Int64.Parse(parent.StartTicks) > Int64.Parse(row.StartTicks))
            throw new InvalidOperationException("Vortex parent generation changed");
        }
        if (expectedMainPid != 0 && rows.Count > 0 && (mains != 1 || main != expectedMainPid))
          throw new OwnedCohortChanged();
        if (mains < 1 && (!allowEmpty || rows.Count != 0)) throw new InvalidOperationException("Vortex root unavailable");
        rows.Sort((a, b) => a.ProcessId.CompareTo(b.ProcessId));
        return new Inventory { Count = rows.Count, Processes = rows.ToArray() };
      } finally { foreach (var process in held) process.Dispose(); }
    }
  }
}
'@
}
# Only emit after the complete snapshot and independent generation checks succeed.
try {
  $inventory = [FixtureProcessInventory.NativeInventory]::Read($AllowEmpty.IsPresent, $ExpectedMainPid)
} catch {
  if ($_.Exception.InnerException -is [FixtureProcessInventory.NativeInventory+OwnedCohortChanged]) {
    [Console]::Error.WriteLine('FIXTURE_PROCESS_COHORT_CHANGED')
    exit 75
  }
  throw
}
Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$inventory | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 5
