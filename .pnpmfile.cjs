const dshPackage = '@deepseek-ai/dsh-'
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

function lockDshDependencies(pkg) {
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(pkg[field] ?? {})) {
      if (dependency.startsWith(dshPackage)) {
        pkg[field][dependency] = '0.1.0-rc.7'
      }
    }
  }

  return pkg
}

module.exports = {
  hooks: {
    readPackage: lockDshDependencies,
  },
}
