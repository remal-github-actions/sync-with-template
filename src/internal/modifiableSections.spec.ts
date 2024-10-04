import {injectModifiableSections, parseModifiableSections} from './modifiableSections.js'

describe('parseModifiableSections', () => {

    it('simple', () => {
        expect(parseModifiableSections('text'))
            .toStrictEqual({})
    })

    it('with closed empty section', () => {
        expect(parseModifiableSections([
            'line',
            '// $$$sync-with-template-modifiable: section $$$',
            '// $$$sync-with-template-modifiable-end$$$',
        ].join('\n')))
            .toStrictEqual({
                section: []
            })
    })

    it('with not closed empty section', () => {
        expect(parseModifiableSections([
            'line',
            '// $$$sync-with-template-modifiable: section $$$',
        ].join('\n')))
            .toStrictEqual({
                section: []
            })
    })

    it('with closed section', () => {
        expect(parseModifiableSections([
            'line',
            '/* $$$sync-with-template-modifiable: section $$$ */',
            '1',
            '2',
            '// $$$sync-with-template-modifiable-end$$$',
        ].join('\n')))
            .toStrictEqual({
                section: ['1', '2']
            })
    })

    it('with not closed section', () => {
        expect(parseModifiableSections([
            'line',
            '/* $$$sync-with-template-modifiable: section $$$ */',
            '1',
            '2',
        ].join('\n')))
            .toStrictEqual({
                section: ['1', '2']
            })
    })

})

describe('injectModifiableSections', () => {

    it('simple', () => {
        expect(injectModifiableSections('text', {}))
            .toStrictEqual('text')
    })

    it('with closed empty section', () => {
        expect(injectModifiableSections(
            [
                'line',
                '// $$$sync-with-template-modifiable: section $$$',
                '// $$$sync-with-template-modifiable-end$$$',
            ].join('\n'),
            {
                'section': ['1', '2']
            }
        ))
            .toStrictEqual(
                [
                    'line',
                    '// $$$sync-with-template-modifiable: section $$$',
                    '1',
                    '2',
                    '// $$$sync-with-template-modifiable-end$$$',
                ].join('\n'),
            )
    })

    it('with not closed empty section', () => {
        expect(injectModifiableSections(
            [
                'line',
                '// $$$sync-with-template-modifiable: section $$$',
            ].join('\n'),
            {
                'section': ['1', '2']
            }
        ))
            .toStrictEqual(
                [
                    'line',
                    '// $$$sync-with-template-modifiable: section $$$',
                    '1',
                    '2',
                ].join('\n'),
            )
    })

    it('with closed section', () => {
        expect(injectModifiableSections(
            [
                'line',
                '// $$$sync-with-template-modifiable: section $$$',
                'a',
                'b',
                '// $$$sync-with-template-modifiable-end$$$',
            ].join('\n'),
            {
                'section': ['1', '2']
            }
        ))
            .toStrictEqual(
                [
                    'line',
                    '// $$$sync-with-template-modifiable: section $$$',
                    '1',
                    '2',
                    '// $$$sync-with-template-modifiable-end$$$',
                ].join('\n'),
            )
    })

    it('with not closed section', () => {
        expect(injectModifiableSections(
            [
                'line',
                '// $$$sync-with-template-modifiable: section $$$',
                'a',
                'b',
            ].join('\n'),
            {
                'section': ['1', '2']
            }
        ))
            .toStrictEqual(
                [
                    'line',
                    '// $$$sync-with-template-modifiable: section $$$',
                    '1',
                    '2',
                ].join('\n'),
            )
    })

})
