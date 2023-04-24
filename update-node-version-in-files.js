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

(function() {
    const json = readJsonFile('package.json')

    json.engines = json.engines || {}
    json.engines.node = `>=${nodeVersion}`

    if (json.devDependencies['@types/node'] == null) {
        json.devDependencies['@types/node'] = ''
    }
    ;[
        'dependencies',
        'devDependencies',
    ].forEach(dependenciesKey => {
        const dependencies = json[dependenciesKey]
        if (dependencies == null) return
        Object.entries(dependencies).forEach(([dependency, version]) => {
            if (dependency !== '@types/node') return
            if (version.startsWith(`${nodeVersion}.`)) return
            dependencies[dependency] = `${nodeVersion}.0.0`
        })
    })

    writeJsonFile('package.json', json)
})()
