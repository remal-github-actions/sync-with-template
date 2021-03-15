import {cache} from './cache'

describe('cache', () => {

    it('sync getter', function () {
        class Test {
            i = 0

            @cache
            get incr(): number {
                return ++this.i
            }
        }

        const test = new Test()

        expect(test.incr).toEqual(1)
        expect(test.incr).toEqual(1)
        expect(test.incr).toEqual(1)

        expect(test.i).toEqual(1)
    })

    it('async getter', () => {
        class Test {
            i = 0

            @cache
            get incr(): Promise<number> {
                return Promise.resolve(++this.i)
            }
        }

        const test = new Test()

        return Promise.all([
            test.incr,
            test.incr,
            test.incr
        ]).then(values => {
            expect(values[0]).toEqual(1)
            expect(values[1]).toEqual(1)
            expect(values[2]).toEqual(1)
            expect(test.i).toEqual(1)
        })
    })

    it('true async getter', () => {
        class Test {
            i = 0

            @cache
            get incr(): Promise<number> {
                return new Promise(resolve => {
                    setImmediate(() => resolve(++this.i))
                })
            }
        }

        const test = new Test()

        return Promise.all([
            test.incr,
            test.incr,
            test.incr
        ]).then(values => {
            expect(values[0]).toEqual(1)
            expect(values[1]).toEqual(1)
            expect(values[2]).toEqual(1)
            expect(test.i).toEqual(1)
        })
    })

    it('fails on setter', () => {
        expect(() => {
            class Test {
                get property(): any {
                    return null
                }

                @cache
                set property(value: any) {
                }
            }
        }).toThrow('Property getter is expected: property')
    })

    it('fails on setter only', () => {
        expect(() => {
            class Test {
                @cache
                set property(value: any) {
                }
            }
        }).toThrow('Property getter is expected: property')
    })

    it('fails on method', () => {
        expect(() => {
            class Test {
                @cache
                property() {
                }
            }
        }).toThrow('Property getter is expected: property')
    })

})
