const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
}

// PowerShell script that sends raw bytes straight to a Windows printer queue
const PS_SCRIPT = `
param([string]$Printer, [string]$Path)
$code = @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

  public static bool SendBytes(string printerName, byte[] bytes) {
    IntPtr h;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "Passbook";
    di.pDataType = "RAW";
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) return false;
    bool ok = false;
    if (StartDocPrinter(h, 1, di)) {
      if (StartPagePrinter(h)) {
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, p, bytes.Length);
        int written;
        ok = WritePrinter(h, p, bytes.Length, out written);
        Marshal.FreeCoTaskMem(p);
        EndPagePrinter(h);
      }
      EndDocPrinter(h);
    }
    ClosePrinter(h);
    return ok;
  }
}
"@
Add-Type -TypeDefinition $code
$bytes = [System.IO.File]::ReadAllBytes($Path)
if (-not [RawPrint]::SendBytes($Printer, $bytes)) { Write-Error "Windows would not accept the job for '$Printer'."; exit 1 }
`;

ipcMain.handle('list-printers', async () => {
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, isDefault: !!p.isDefault }));
});

ipcMain.handle('print-raw', async (_event, printer, text) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Direct printing works on Windows only.' };
  if (typeof printer !== 'string' || !printer || typeof text !== 'string') {
    return { ok: false, error: 'Missing printer or text.' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbook-'));
  const dataFile = path.join(dir, 'job.prn');
  const psFile = path.join(dir, 'raw.ps1');
  fs.writeFileSync(dataFile, Buffer.from(text, 'latin1'));
  fs.writeFileSync(psFile, PS_SCRIPT, 'utf8');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-Printer', printer, '-Path', dataFile],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
        if (err) resolve({ ok: false, error: String(stderr || stdout || err.message || '').trim().slice(0, 300) });
        else resolve({ ok: true });
      }
    );
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
