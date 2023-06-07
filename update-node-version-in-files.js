const fs = require('fs')

const encoding = 'utf8'

const nodeVersionString = process.argv[2]
const nodeVersion = parseInt(nodeVersionString)
if (isNaN(nodeVersion)) {
    throw new Error(`Node.js major version should be passed as a script parameter: ${nodeVersionString}`)
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
    fs.writeFileSync('.nvmrc', `v${nodeVersion}`, encoding)
})()

;(function() {
    const json = readJsonFile('package.json')

    json.engines = json.engines || {}
    json.engines.node = `>=${nodeVersion}`

    if (json.devDependencies[`@tsconfig/node${nodeVersion}`] == null) {
        json.devDependencies[`@tsconfig/node${nodeVersion}`] = '1.0.0'
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
