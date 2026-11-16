import path from 'node:path';

export function isolateHistoricalAncestry(io, workspace) {
  const sharedParents = new Set();
  for (let parent = path.dirname(workspace); !sharedParents.has(parent); parent = path.dirname(parent)) {
    sharedParents.add(parent);
  }
  const fixtureIO = Object.create(io);
  fixtureIO.lstatSync = (file, options) => {
    const stat = io.lstatSync(file, options);
    if (!options?.bigint || !sharedParents.has(file) || !stat.isDirectory()) return stat;
    // Earlier Main source stages pinned mutable metadata all the way to the
    // drive root. Unrelated writes there must stay outside this owned fixture.
    // Keep real volume, inode and kind, and pass every owned path through.
    return Object.create(stat, {
      size: { value: 0n }, mtimeNs: { value: 0n }, ctimeNs: { value: 0n }, nlink: { value: 1n },
    });
  };
  return fixtureIO;
}
