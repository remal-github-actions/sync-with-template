import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'
import jest from 'eslint-plugin-jest'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'
import filenames from 'eslint-plugin-filenames'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
    {
        ignores: ['**/*', '!src/', '!src/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    importPlugin.flatConfigs.recommended,
    importPlugin.flatConfigs.typescript,
    jest.configs['flat/recommended'],
    prettierRecommended,
    prettier,
    {
        files: ['src/**/*.{ts,tsx,cts,mts,js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        plugins: {
            'eslint-comments': eslintComments,
            filenames,
        },
        settings: {
            'import/parsers': {
                '@typescript-eslint/parser': ['.ts', '.cts', '.mts', '.tsx'],
            },
            'import/resolver': {
                typescript: {
                    alwaysTryTypes: true,
                    project: './tsconfig.json',
                },
            },
        },
        rules: {
            'eslint-comments/disable-enable-pair': 'error',
            'eslint-comments/no-aggregating-enable': 'error',
            'eslint-comments/no-duplicate-disable': 'error',
            'eslint-comments/no-unused-enable': 'error',
            'eslint-comments/no-unlimited-disable': 'off',
            'eslint-comments/no-use': 'off',
            'eslint-comments/no-unused-disable': 'off',
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
            'import/extensions': 'off',
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
                    ignoreRestSiblings: true,
                },
            ],
        },
    },
]
