const fs = require('fs')
const semver = require('semver')

let nodeVersion = fs.readFileSync('.nvmrc', 'utf8').trim()
console.log(`Checking that engines.node in package.json file of all dependencies satisfies Node.js version ${nodeVersion}...`)
if (nodeVersion.match(/^v?\d+$/)) nodeVersion += '.9999.9999'

function processPackageJsonFiles(dir) {
    const files = fs.readdirSync(dir)
    if (files.includes('package.json')) {
        const packageJsonFile = `${dir}/package.json`
        const packageJsonContent = fs.readFileSync(packageJsonFile, 'utf8').trim()
        const packageJson = JSON.parse(packageJsonContent)
        const nodeRange = packageJson.engines?.node
        if (nodeRange != null) {
            if (!semver.satisfies(nodeVersion, nodeRange)) {
                throw new Error(`Incompatible engines.node in ${packageJsonFile}: ${nodeRange}`)
            }
        }
        return
    }

    for (const file of files) {
        const nextDir = `${dir}/${file}`
        if (fs.statSync(nextDir).isDirectory()) {
            processPackageJsonFiles(nextDir)
        }
    }
}

processPackageJsonFiles('node_modules')
