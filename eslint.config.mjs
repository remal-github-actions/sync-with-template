import { FlatCompat } from '@eslint/eslintrc'
import eslint from '@eslint/js'
import _import from 'eslint-plugin-import'
import jest from 'eslint-plugin-jest'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import globals from 'globals'
import path from 'path'
import tseslint from 'typescript-eslint'
import { fileURLToPath } from 'url'

// mimic CommonJS variables -- not needed if using CommonJS
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({
    baseDirectory: __dirname
})

export default [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    ...compat.extends('plugin:github/recommended'),
    prettierRecommended,
    {
        ignores: ['**/*', '!src/**'],

        files: ['**/*.js', '**/*.cjs', '**.*.mjs', '**/*.ts', '**/*.cts', '**.*.mts'],

        plugins: {
            import: _import,
            jest
        },

        languageOptions: {
            globals: {
                ...globals.node,
                ...jest.environments.globals.globals
            },
            parserOptions: {
                project: './tsconfig.json'
            }
        },

        rules: {
            'github/no-implicit-buggy-globals': 'off', // broken, see https://github.com/github/eslint-plugin-github/issues/539

            'eslint-comments/no-unlimited-disable': 'off',
            'eslint-comments/no-use': 'off',
            'filenames/match-regex': 'off',
            'prettier/prettier': 'off',
            semi: 'off',
            camelcase: 'off',
            'no-unused-vars': 'off',
            'no-inner-declarations': 'off',
            'no-prototype-builtins': 'off',
            'prefer-template': 'off',
            'import/no-commonjs': 'off',
            'import/no-namespace': 'off',
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true
                }
            ],
            'i18n-text/no-en': 'off',
            'github/no-then': 'off',
            'github/array-foreach': 'off'
        },

        settings: {
            'import/resolver': {
                'typescript': true,
                'node': true,
            },
        },
    },
]
