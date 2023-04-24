const fs = require('fs')

const encoding = 'utf8'
const content = fs.readFileSync('tsconfig.json', encoding)
const json = JSON.parse(content)
fs.writeFileSync('tsconfig.json', JSON.stringify(json, null, 2) + '\n', encoding)

json.compilerOptions = json.compilerOptions || {}
json.compilerOptions.types = json.compilerOptions.types || []
const jestTypeIndex = json.compilerOptions.types.findIndex(type => type.toLowerCase() === 'jest')
json.compilerOptions.types.splice(jestTypeIndex, 1)

json.exclude = json.exclude || []
json.exclude.push('**/*.spec.*')

const appContent = JSON.stringify(json, null, 2).replaceAll(/(\r\n)|(\n\r)|(\r)/g, '\n') + '\n'
fs.writeFileSync('tsconfig.app.json', appContent, encoding)
