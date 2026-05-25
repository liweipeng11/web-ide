import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpError } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function pickWorkspaceFolder() {
  if (process.platform !== "win32") {
    throw new HttpError(501, "Folder picker is only implemented for Windows in this version");
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select project folder'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }"
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeout: 10 * 60 * 1000,
      windowsHide: false
    }
  );

  const selectedPath = stdout.trim();

  return selectedPath || null;
}
