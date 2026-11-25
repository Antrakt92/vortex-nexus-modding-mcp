# Get started on Windows

Releases contain source code. To use the Vortex tools, build and install the
extension, then connect it to your terminal or MCP client.

## Choose your route

| You want to… | Start with |
| --- | --- |
| Connect Vortex to an AI client or terminal | The adapter setup below |
| Search public Nexus metadata | [Community CLI setup](../tools/modding/nexus-cli/README.md) |
| Upload a mod you maintain | [Publication runner](../tools/modding/nexus-publish/README.md) |
| Contribute code | [Contributing](../CONTRIBUTING.md) |

These routes are independent; the publication runner is not needed to inspect Vortex.

## Requirements

| Component | Requirement |
| --- | --- |
| Operating system | Windows; Vortex installed separately |
| Source and recovery | Git and Python 3.11 or newer |
| Adapter build/client | Node 24 and the pinned local pnpm bootstrap from [RESTORE.md](RESTORE.md#3-prepare-the-adapter-build) |
| Publication runner, optional | Node 24 with built-in Undici 7.18.2+ in the 7.x line |
| Community CLI, optional | .NET 10 for the pinned Windows x64 executable |
| AI client, optional | An MCP client that can launch a local stdio command; terminal commands work without one |

Installation and deployment of new local Cyberpunk 2077 ZIPs were verified on
reviewed official packages of [Vortex 2.9.1](STOCK-LOCAL-INSTALL.md#verification-boundary),
[2.10.1](STOCK-LOCAL-INSTALL.md#verify-official-vortex-2101) and
[2.11.0](STOCK-LOCAL-INSTALL.md#verify-official-vortex-2110). Collection controls
have their own host and workflow requirements. See
[collection workflows](BACKGROUND-COLLECTION-WIZARD.md) and
[native questions](NATIVE-DIALOGS.md).
Process checks also exist for Assassin's Creed Unity, Skyrim SE, Skyrim VR and
Fallout 4. Full installation and deployment coverage varies by game. Unsupported
writes stop with `UNSUPPORTED_GAME_PROCESS_GUARD`.

## Install the adapter

1. Download the source ZIP and its adjacent `.zip.sha256` file from the
   [latest release](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/latest).
   Compare the ZIP's `Get-FileHash -Algorithm SHA256` result with that checksum,
   then extract it to your chosen source directory. A development checkout of
   `main` can contain changes not yet in a release.
2. If this Windows account has never run Vortex, start it normally once and
   let it initialize its default user data. Close Vortex normally. The adapter
   installer requires the existing `%APPDATA%\Vortex\plugins` directory.
3. Open PowerShell in that source directory. Follow [RESTORE.md](RESTORE.md) to
   verify the source, choose an absolute runtime workspace, recover pinned
   inputs and build and package the adapter.
4. Initialize the local per-user bearer using the documented credential command.
   Keep the game and Vortex closed while taking the protected-state snapshots
   and installing or upgrading the extension. The installer checks the package
   hash and leaves Vortex closed.
5. Start Vortex normally. Run the first read below. Ordinary supported operations
   reuse this running host without restarting it.

For an existing installation, follow the [upgrade route](RESTORE.md#4-initialize-local-credentials-and-review-installation).
Preserve its runtime workspace, credentials and operation receipts. A new source
checkout is not a reason to initialize a second operational workspace.

## Make your first read

From the source directory, set this only if your installed package uses a
separate runtime workspace:

```powershell
$env:NEXUS_WORKSPACE = 'C:/NexusWorkspace'
```

Then run:

```powershell
node tools/modding/vortex-agent/bridge.mjs --health
node tools/modding/vortex-agent/session.mjs inspect --diagnostics
```

The health response should show your game, profile and folders. Inspection
returns `status: "ok"` when all requested reads finish. Check the reported
conflicts and collection status as well. `partial` means a read failed or a list
reached its limit. These commands do not change enabled mods or deploy them.

## Connect an MCP client

After the terminal health check works, preview and write the configuration
template. With `NEXUS_WORKSPACE` unset, the commands use the source directory.

```powershell
python scripts/recovery.py configure
python scripts/recovery.py configure --apply
```

For a separate installed runtime workspace, use its absolute path. If you set
`NEXUS_WORKSPACE` for the health check above, the same commands already use it.
You can also supply the path directly.

```powershell
python scripts/recovery.py configure --workspace 'C:/NexusWorkspace'
python scripts/recovery.py configure --workspace 'C:/NexusWorkspace' --apply
```

The command with `--apply` writes `local-state/nexus-tools-recovery/client-template.json`
under the selected workspace. Merge its `vortex` server entry into your client's
configuration and refresh the MCP connection. Some clients use TOML instead of
JSON; adapt the same command, absolute bridge path and environment values.
No bearer token or Nexus API key belongs in the client entry.

The command-line tools work without an AI subscription or the maintainer's
private agent instructions. If you use an AI client, its model access and
charges depend on that service.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP unavailable / connection refused | Vortex is running, the resident extension is installed, and its bundle matches the reviewed package. Check its log for a bind error. |
| Authentication fails | Bridge and installed package use the same runtime workspace and Windows account. Do not copy another account's credential store. |
| Old tools or schemas after an update | Refresh the MCP connection for bridge changes. Native extension changes additionally need the documented upgrade and Vortex restart. |
| Inspection is partial or a list reaches its limit | Inspect the errors and narrow the requested scope. A capped list is not complete proof. |
| An uncertain operation blocks writes | Inspect the original request's receipts and use reconciliation. Do not delete interlocks or invent a new request ID to retry. |
| You want to install a mod archive | New own-local Cyberpunk ZIPs use [the scoped installer](STOCK-LOCAL-INSTALL.md). Replacements, Nexus updates and interactive archives retain their separate reviewed native workflows. |

For plan examples, see [the running-session guide](NO-RESTART-WORKFLOW.md).
For help, use [the support guide](../SUPPORT.md).
