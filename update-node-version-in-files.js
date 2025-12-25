import * as fs from 'fs'

const encoding = 'utf8'

const nodeVersionString = process.argv[2]
const nodeVersion = parseInt(nodeVersionString)
if (isNaN(nodeVersion)) {
    throw new Error(`Node.js major version must be passed as a script parameter: ${nodeVersionString}`)
}

function readJsonFile(path) {
    const content = fs.readFileSync(path, encoding)
    return JSON.parse(content)
}

function writeJsonFile(path, json) {
    let content = JSON.stringify(json, null, 2) + '\n'
    content = content.replaceAll(/(\r\n)|(\n\r)|(\r)/g, '\n')
    fs.writeFileSync(path, content, encoding)
}

;(function() {
    const currentVer = parseInt(
        fs.readFileSync('.nvmrc', encoding).trim().replace(/^v/, '')
    )
    if (currentVer !== nodeVersion) {
        fs.writeFileSync('.nvmrc', `v${nodeVersion}`, encoding)
    }
})()

;(function() {
    const json = readJsonFile('package.json')

    json.engines = json.engines || {}
    json.engines.node = `>=${nodeVersion}`

    for (let currentNodeVersion = 1; currentNodeVersion <= nodeVersion + 20; currentNodeVersion++) {
        if (currentNodeVersion === nodeVersion) {
            if (json.devDependencies[`@tsconfig/node${currentNodeVersion}`] == null) {
                json.devDependencies[`@tsconfig/node${currentNodeVersion}`] = '1.0.0'
            }
        } else {
            delete json.devDependencies[`@tsconfig/node${currentNodeVersion}`]
        }
    }
    if (json.devDependencies['@types/node'] == null) {
        json.devDependencies['@types/node'] = `${nodeVersion}.0.0`
    }

    ;[
        'dependencies',
        'devDependencies',
    ].forEach(dependenciesKey => {
        const dependencies = json[dependenciesKey]
        if (dependencies == null) return

        Object.entries(dependencies).forEach(([dependency, version]) => {
            if (dependency.startsWith('@tsconfig/node') && dependency !== `@tsconfig/node${nodeVersion}`) {
                delete dependencies[dependency]
            }
        })

        Object.entries(dependencies).forEach(([dependency, version]) => {
            if (dependency === '@types/node' && !version.startsWith(`${nodeVersion}.`)) {
                dependencies[dependency] = `${nodeVersion}.0.0`
            }
        })
    })

    writeJsonFile('package.json', json)
})()

;(function() {
    const json = readJsonFile('tsconfig.json')

    if ((json.extends || '').startsWith('@tsconfig/node')) {
        json.extends = `@tsconfig/node${nodeVersion}/tsconfig.json`
    }

    writeJsonFile('tsconfig.json', json)
})()

;(function() {
    const content = fs.readFileSync('.github/renovate.json5', encoding)
    const modifiedContent = content.replace(
        /([ ]*)\/\/\s*\$\$\$sync-with-template-modifiable:\s*(force: \{\s*)?constraints\s*\$\$\$[\s\S]*?\/\/\s*\$\$\$sync-with-template-modifiable-end\s*\$\$\$/,
        `$1// $$$$$sync-with-template-modifiable: constraints $$$$$\n$1constraints: {\n$1$1node: "^${nodeVersion}.9999.9999",\n$1},\n$1force: {\n$1$1constraints: {\n$1$1$1node: "^${nodeVersion}.9999.9999",\n$1$1},\n$1},\n$1// $$$$$sync-with-template-modifiable-end$$$$$`
    )
    if (modifiedContent !== content) {
        fs.writeFileSync('.github/renovate.json5', modifiedContent, encoding)
    }
})()
