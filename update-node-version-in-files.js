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
    const currentVerRaw = fs.readFileSync('.nvmrc', encoding).trim()
    const currentVer = parseInt(currentVerRaw.replace(/^v/, ''))
    if (currentVer !== nodeVersion) {
        console.log(`.nvmrc: ${currentVerRaw} -> v${nodeVersion}`)
        fs.writeFileSync('.nvmrc', `v${nodeVersion}`, encoding)
    } else {
        console.log(`.nvmrc: ${currentVerRaw} (up to date)`)
    }
})()

;(function() {
    const content = fs.readFileSync('.tool-versions', encoding)
    const match = content.match(/^nodejs\s+(\d+\.\d+\.\d+)$/m)
    const currentVerFull = match && match[1]
    const currentVer = currentVerFull && parseInt(currentVerFull)
    if (currentVer != null && currentVer !== nodeVersion) {
        console.log(`.tool-versions: ${currentVerFull} -> ${nodeVersion}.0.0`)
        const modifiedContent = content.replace(
            /^(nodejs\s+)\d+\.\d+\.\d+$/m,
            `$1${nodeVersion}.0.0`
        )
        fs.writeFileSync('.tool-versions', modifiedContent, encoding)
    } else if (currentVer != null) {
        console.log(`.tool-versions: ${currentVerFull} (up to date)`)
    }
})()

;(function() {
    const json = readJsonFile('package.json')

    json.engines = json.engines || {}
    const currentEngineNode = json.engines.node
    json.engines.node = `>=${nodeVersion}`
    if (currentEngineNode !== json.engines.node) {
        console.log(`package.json engines.node: ${currentEngineNode || '(not set)'} -> ${json.engines.node}`)
    } else {
        console.log(`package.json engines.node: ${currentEngineNode} (up to date)`)
    }

    if (json.devDependencies[`@tsconfig/node${nodeVersion}`] == null) {
        console.log(`Adding @tsconfig/node${nodeVersion} dependency`)
        json.devDependencies[`@tsconfig/node${nodeVersion}`] = `${nodeVersion}.0.0`
    }
    if (json.devDependencies['@types/node'] == null) {
        console.log(`Adding @types/node dependency`)
        json.devDependencies['@types/node'] = `${nodeVersion}.0.0`
    }

    ;[
        'dependencies',
        'devDependencies',
    ].forEach(dependenciesKey => {
        const dependencies = json[dependenciesKey]
        if (dependencies == null) {
            return
        }

        Object.entries(dependencies).forEach(([dependency, version]) => {
            if (dependency.startsWith('@tsconfig/node') && dependency !== `@tsconfig/node${nodeVersion}`) {
                console.log(`Removing ${dependency} dependency`)
                delete dependencies[dependency]
            }
        })

        Object.entries(dependencies).forEach(([dependency, version]) => {
            if (dependency === '@types/node' && !version.startsWith(`${nodeVersion}.`)) {
                const newVersion = `${nodeVersion}.0.0`
                console.log(`Setting version of ${dependency} dependency to ${newVersion}`)
                dependencies[dependency] = newVersion
            }
        })
    })

    writeJsonFile('package.json', json)
})()

;(function() {
    const json = readJsonFile('tsconfig.json')

    if ((json.extends || '').startsWith('@tsconfig/node')) {
        const currentExtends = json.extends
        json.extends = `@tsconfig/node${nodeVersion}/tsconfig.json`
        if (currentExtends !== json.extends) {
            console.log(`tsconfig.json extends: ${currentExtends} -> ${json.extends}`)
        } else {
            console.log(`tsconfig.json extends: ${currentExtends} (up to date)`)
        }
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
