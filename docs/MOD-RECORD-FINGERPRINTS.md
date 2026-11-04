# Compare native mod metadata

`read_mod_record_fingerprints` reads 1–20 exact installed mod records in the
current game/profile. It returns record hashes, hashes of field names and values,
and ordered and multiset rule fingerprints. It does not read mod files or return
raw metadata values.

Supply `gameId`, `profileId` and `modIds`. The context and selected records must
remain unchanged across the read. Missing records, malformed data and unsupported
record shapes refuse.

An optional `ruleOrderBaselines` array accepts `{modId, ruleElementDigests}` for
requested records. The ordered vector contains the exact retained hashes of the
original rules. When the current rule multiset matches, `baselineRuleOrder`
returns the hash of the current record with only its rules reordered to that
vector. Duplicate rules retain their counts. If the multisets differ, it returns
`matched:false` without a reconstructed record hash.

Compare the reconstructed hash with the independently retained original record
hash. Equality proves that the selected record differs only by rule order under
the hashing contract. This does not establish whether order affects a particular
consumer, mod compatibility, installation, deployment or gameplay. No metadata is
changed, and a matching hash grants no permission to clear an operation hold.

The hashing format preserves own `undefined` properties, array indices and
negative zero. It uses descriptor-only snapshots and SHA-256 over the tagged
encoding; ordinary `JSON.stringify(record)` is not interchangeable.
