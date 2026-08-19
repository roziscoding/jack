import createPreset, { DEFAULT_COMMIT_TYPES } from 'conventional-changelog-conventionalcommits'

// The conventionalcommits preset hides docs, style, chore, refactor, test,
// build and ci from the changelog. Release notes here list every commit, so
// clear the `hidden` effect and let each type render under its own section.
export default createPreset({
  types: DEFAULT_COMMIT_TYPES.map(type =>
    type.effect === 'hidden'
      ? { type: type.type, section: type.section }
      : type,
  ),
})
