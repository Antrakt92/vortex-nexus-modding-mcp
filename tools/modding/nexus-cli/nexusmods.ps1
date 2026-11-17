# Stable, working-directory-independent entrypoint; credentials stay in Credential Manager.
$ErrorActionPreference = 'Stop'
$workspace = if ($env:NEXUS_WORKSPACE) { $env:NEXUS_WORKSPACE } else { [System.IO.Path]::Combine($PSScriptRoot, '../../..') }
if ($workspace -notmatch '^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') { throw 'NEXUS_WORKSPACE must be an absolute path.' }
$workspace = [System.IO.Path]::GetFullPath($workspace)
$exe = [System.IO.Path]::Combine($workspace, 'local-state/nexus-cli/1.1.1/nexusmods.exe')
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'Nexus CLI is missing. Inspect tools/modding/nexus-cli/README.md and installation.json.'
}
# These pins come from the release archive verified by install.py. A receipt
# written beside the executable would change along with a replaced installation.
$runtimePins = [ordered]@{
    'nexusmods.exe' = '0e08f591096c25ac979914c60be7fd057bd719faebbde865d4556cba37afb45e'
    'nexusmods.dll' = 'cf57c5cbe522ddd3637ac4e1605e1b2f951afa734f37ea5aecffd306812ca7f8'
    'System.CommandLine.dll' = '467d0cc5e0242bac33733d94fc8842114ef861537780acdd5f1abeff1f5c7bc7'
    'nexusmods.deps.json' = 'a24a0ffc1b926eb9b6e7b0f2080ea476e3645bef77af34bcffe11a71b671ffb3'
    'nexusmods.runtimeconfig.json' = 'c230a317a54dd960bcbeb5f347f52e18dc665a26f7efda2159fced9a5ac7e097'
    'cs/System.CommandLine.resources.dll' = '9354305a05c34108cc5762d7734db3b7cc0d5a0f179b0d68edc5f7c7d06a72fe'
    'de/System.CommandLine.resources.dll' = '9e48a818778ba74b151d89229e349fb1dd3d78e2d9d11e39328e2e42ebb6a4ed'
    'es/System.CommandLine.resources.dll' = '86eb316d3c2c91573a1f7b1e2a69b88c84d4df9531d47459211b9535f7c61a0a'
    'fr/System.CommandLine.resources.dll' = 'baf2921a043359ef11762563d3feb0f5238e4ead58cd52a30c4f8cad38804b7b'
    'it/System.CommandLine.resources.dll' = 'fe7575b6aa0acbd75e4c6653549786033d8a12dd1b892f1ef4f665d560d0a002'
    'ja/System.CommandLine.resources.dll' = '45b3b69776e4959ccd1656cd562408f4bd8903cee2cc156b1d7fe0144ae752a4'
    'ko/System.CommandLine.resources.dll' = '2e52c3cd2c3a1f54b51de1dcd7cd33db8f269c3c0898cca5977593df234dbfb6'
    'pl/System.CommandLine.resources.dll' = '48f198d0bfbc2e5a88f82b8cda449944f24860e16074df8b585a6b092b8595a5'
    'pt-BR/System.CommandLine.resources.dll' = 'a432919a7e00626c3d63eeee80a73cc081e4d82197b289f07199a9c99621330a'
    'ru/System.CommandLine.resources.dll' = 'a672cdd7ec823e73c1cb3795fa716d41514780149dde86480f0a8d49b4a74426'
    'tr/System.CommandLine.resources.dll' = '357e87639d3c57d5feedab536ed991ee1108bbf95c5cad9f36a1b653be3372ee'
    'zh-Hans/System.CommandLine.resources.dll' = '106c5f77061df4394ebb91a01a441ab6df398c24a39814100a449135cd93cf12'
    'zh-Hant/System.CommandLine.resources.dll' = 'a6ecb412b55cbe8b0a47871c249f7d603dc9186daa7fb4475aad691e3810c1b8'
}
$runtimeRoot = [IO.Path]::GetDirectoryName($exe)
$ancestors = [Collections.Generic.Stack[string]]::new()
for ($dir = [IO.DirectoryInfo]::new($runtimeRoot); $null -ne $dir; $dir = $dir.Parent) {
    $ancestors.Push($dir.FullName)
}
while ($ancestors.Count) {
    if ([IO.File]::GetAttributes($ancestors.Pop()) -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Nexus CLI runtime differs: reparse path refused.'
    }
}
foreach ($name in $runtimePins.Keys) {
    $file = [IO.Path]::Combine($runtimeRoot, $name)
    $parent = [IO.Path]::GetDirectoryName($file)
    if (-not [IO.File]::Exists($file) -or
        ([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -or
        ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Nexus CLI runtime differs: $name. Restore the pinned release before running it."
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($file)
        try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose() }
    } finally { $hasher.Dispose() }
    if ($actual -ne $runtimePins[$name]) {
        throw "Nexus CLI runtime differs: $name. Restore the pinned release before running it."
    }
}
& $exe @args
exit $LASTEXITCODE
