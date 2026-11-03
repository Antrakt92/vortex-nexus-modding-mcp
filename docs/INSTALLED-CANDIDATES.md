# Assess an installed update candidate

`assess_installed_candidates` compares up to 20 exact installed old/candidate
pairs against an installed collection and other incoming `requires` rules.
It reads metadata only: no disk scan, download, installation, profile switch,
enablement, deployment or removal.

Start with fresh `health`, then use exact installed IDs from `list_mods`:

```json
{
  "gameId": "cyberpunk2077",
  "profileId": "EXACT_ACTIVE_PROFILE",
  "collectionModId": "EXACT_INSTALLED_COLLECTION",
  "comparisons": [
    {"oldModId": "OLD_INSTALLED_ID", "candidateModId": "CANDIDATE_INSTALLED_ID"}
  ]
}
```

Pass this JSON to `assess_installed_candidates` through MCP or the maintained
bridge CLI. The active game/profile must match. The result records the observed
collection and revision IDs; optional `expectedRevisionId` checks a known pin.
The candidate must already have an installed record. A downloaded archive alone
does not establish its installer choices or installed variant.

## Read the result

| Per-pair status | Meaning |
| --- | --- |
| `compatible_installed_variant` | The assessed recorded incoming requirements match this installed candidate, without an unresolved review gate. |
| `conflict` | A known identity, type or recorded installation-specification conflict exists. Other unknowns may also be present. |
| `insufficient_evidence` | A rule, matcher, profile flag, customization or other required input could not be resolved. |

Top-level `status:ok` means the assessment completed; it can contain conflicts.
`partial` reports unresolved evidence. Inspect each comparison and its fixed
reason codes. `metadataOnly:true`, `effectsAllowed:false`, `migrationReady:false`
and `diskDeploymentVerified:false` apply even to a compatible result.

The tool uses native `testModReference` independently from native `findModByRef`
with `ruleInstallSpec`. Both are required: the latter has a hash-hint shortcut
which does not establish the full identity by itself. All incoming requirements
matching the old identity are considered, including ignored rules and an old
provider whose recorded specification was already unsatisfied.

The selected collection member needs a meaningful, unique native rule ID.
Optional per-comparison `ruleId` selects an exact known native ID; it cannot
resolve duplicate IDs. A native ID omits some specification fields, so it is
never a specification pin by itself. Results return opaque ID/rule fingerprints
instead of raw references, expressions, paths, installer choices or errors.

Profiles, pending-removal flags and shared archive references are reported for
review. Customizations, preferences, overrides, outgoing ordering/conflict rules
and candidate dependency requirements can require further assessment. An ignored
requirement is reported and retained; the tool never changes its ignored flag.

## Boundaries

Recorded specification matching does not prove staged files, FOMOD outputs,
compatibility in the game, deployment priority, retained rollback inputs or safe
replacement/removal. Matching archives and matching installed variants are
separate questions. No automatic migration or deletion follows this assessment.

Native calls receive detached bounded data. Relevant rule/profile-flag/context drift discards
the observation. Scan, response, clone and cumulative work limits fail explicitly;
they do not return a truncated compatible result. Missing native APIs and invalid
responses remain unknown. Fingerprints support a later fresh comparison and
provide no permission to perform an effect.

The API route is reviewed against official Vortex 2.9.1. Source/model tests,
compiled MCP acceptance and native host loading are separate verification gates.

On 3 November 2026, the actual compiled RPC/native API passed an isolated stock
host fixture for compatible records, identity conflict, recorded FOMOD choices,
ignored requirements and a pending second profile. Every read preserved state
and dispatched nothing. The test records were metadata-only and prove no staged
payload compatibility; the ordinary collection was not changed.
