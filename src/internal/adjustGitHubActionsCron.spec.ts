import { processCronTokenPart } from './adjustGitHubActionsCron.js'

describe(processCronTokenPart.name, () => {

    it('star', () => {
        expect(processCronTokenPart('*', 1, 10))
            .toStrictEqual('*')
    })

    it('unsupported', () => {
        expect(processCronTokenPart('asd', 1, 10))
            .toStrictEqual('asd')
    })

    it('number', () => {
        expect(processCronTokenPart('1', 1, 10))
            .toStrictEqual('2')
        expect(processCronTokenPart('1', 12, 10))
            .toStrictEqual('3')
    })

    it('range', () => {
        expect(processCronTokenPart('1-3', 1, 10))
            .toStrictEqual('2-4')
        expect(processCronTokenPart('1-5', 8, 10))
            .toStrictEqual('0-4')
    })

    it('every', () => {
        expect(processCronTokenPart('1/3', 1, 10))
            .toStrictEqual('2/3')
        expect(processCronTokenPart('1/3', 8, 10))
            .toStrictEqual('0/3')
        expect(processCronTokenPart('1/15', 1, 10))
            .toStrictEqual('2/15')
        expect(processCronTokenPart('1/15', 11, 10))
            .toStrictEqual('2/15')
    })

})
