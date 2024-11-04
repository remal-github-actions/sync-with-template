import fs from 'fs'
import * as os from 'node:os'
import path from 'path'
import { isTextFile } from './isTextFile.js'

describe(isTextFile.name, () => {

    it('does not exists', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), isTextFile.name))
        const file = `${dir}/file`

        expect(isTextFile(file)).toBeFalsy()

        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('empty file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), isTextFile.name))
        const file = `${dir}/file`
        fs.writeFileSync(file, '')

        expect(isTextFile(file)).toBeFalsy()

        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('text file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), isTextFile.name))
        const file = `${dir}/file`

        const buffer = Buffer.alloc(10)
        buffer.fill(65)
        fs.writeFileSync(file, buffer)

        expect(isTextFile(file)).toBeTruthy()

        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('binary file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), isTextFile.name))
        const file = `${dir}/file`

        const buffer = Buffer.alloc(10)
        buffer.fill(0)
        buffer.fill(65, 1)
        fs.writeFileSync(file, buffer)

        expect(isTextFile(file)).toBeFalsy()

        fs.rmSync(dir, { recursive: true, force: true })
    })

})
