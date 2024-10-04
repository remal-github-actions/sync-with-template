import * as fs from 'fs'

const targetFile = './dist/package.json'
fs.writeFileSync(
    targetFile,
    JSON.stringify({
        type: 'commonjs'
    }, null, 2),
    `utf8`
)
