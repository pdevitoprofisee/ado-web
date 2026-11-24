import { spawn } from 'node:child_process'

// `@napi-rs/keyring` writes Windows credentials with enterprise persistence,
// which roams to every domain machine the user signs in to when the profile
// roams. It has no option to change that, so writes go through `CredWriteW`
// here with local-machine persistence. Reads and deletes still use the keyring:
// they address the entry by target and do not care how it persists.
//
// PowerShell rather than a native FFI package: writes happen only when a token
// is saved, and this adds no dependency. The secret goes over stdin, never the
// command line, where any process could read it.

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class LocalMachineCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, int flags);

  const int CRED_TYPE_GENERIC = 1;
  const int CRED_PERSIST_LOCAL_MACHINE = 2;

  public static void Write(string target, string user, string secret) {
    // UTF-16LE, because that is what the keyring decodes on read.
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    IntPtr buffer = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, buffer, blob.Length);
      var credential = new CREDENTIAL {
        Type = CRED_TYPE_GENERIC, TargetName = target, UserName = user,
        CredentialBlobSize = blob.Length, CredentialBlob = buffer,
        Persist = CRED_PERSIST_LOCAL_MACHINE,
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.Copy(new byte[blob.Length], 0, buffer, blob.Length);
      Marshal.FreeHGlobal(buffer);
      Array.Clear(blob, 0, blob.Length);
    }
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[LocalMachineCredential]::Write($request.target, $request.user, $request.secret)
`

const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')

/** Creates or replaces the generic credential `target` with local-machine persistence. */
export function writeLocalMachineCredential(
  target: string,
  user: string,
  secret: string,
): Promise<void> {
  return new Promise((settle, fail) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT],
      { windowsHide: true },
    )

    const errors: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.on('error', fail)
    child.on('close', (code) => {
      if (code === 0) return settle()

      const detail = Buffer.concat(errors).toString('utf8').trim()
      fail(new Error(`Saving the credential failed. ${detail.includes(secret) ? '' : detail}`.trim()))
    })

    child.stdin.end(JSON.stringify({ target, user, secret }))
  })
}
