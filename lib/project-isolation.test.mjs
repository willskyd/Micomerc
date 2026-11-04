import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = process.cwd()

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return entry.isFile() && file.endsWith('.ts') ? [file] : []
  })
}

function resolvesToMicomerc(sourceFile, expression, visited = new Set()) {
  if (ts.isStringLiteral(expression)) return expression.text === 'micomerc'
  if (!ts.isIdentifier(expression) || visited.has(expression.text)) return false
  visited.add(expression.text)

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const specifier of statement.importClause.namedBindings.elements) {
        const localName = specifier.name.text
        const importedName = specifier.propertyName?.text ?? localName
        if (localName !== expression.text) continue
        if (statement.moduleSpecifier.text.endsWith('/database') && importedName === 'DB_NAME') return true
        if (statement.moduleSpecifier.text.endsWith('/inventory') && importedName === 'INVENTORY_DB') return true
      }
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === expression.text && declaration.initializer) {
        return resolvesToMicomerc(sourceFile, declaration.initializer, visited)
      }
    }
  }
  return false
}

test('all Micomerc API database handles are explicitly bound to micomerc', () => {
  const routes = sourceFiles(path.join(root, 'app/api')).filter((file) => file.endsWith(`${path.sep}route.ts`))
  const accesses = []
  for (const file of routes) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'db') {
        assert.equal(node.arguments.length, 1, `${path.relative(root, file)} must not rely on the URI default database`)
        assert.ok(resolvesToMicomerc(sourceFile, node.arguments[0]), `${path.relative(root, file)} must select the Micomerc database`)
        accesses.push(file)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  assert.ok(accesses.length > 0)
})

test('MongoDB configuration cannot fall back to a shared generic URI variable', () => {
  const source = readFileSync(path.join(root, 'lib/mongodb.ts'), 'utf8')
  assert.match(source, /process\.env\.MICOMERC_MONGODB_URI/)
  assert.doesNotMatch(source, /process\.env\.MONGODB_URI/)
  assert.match(readFileSync(path.join(root, '.env.example'), 'utf8'), /^MICOMERC_MONGODB_URI=/m)
})

test('offline sync only accepts Micomerc-owned API routes and methods', async () => {
  const source = readFileSync(path.join(root, 'lib/offline-queue.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'module', compiled)(module.exports, module)
  const { isMicomercSyncTarget, saveQueuedOperation } = module.exports

  for (const [target, method] of [
    ['/api/products', 'POST'],
    ['/api/products/12', 'PATCH'],
    ['/api/debts/12', 'DELETE'],
    ['/api/pending-orders', 'PATCH'],
    ['/api/settings', 'PATCH'],
    ['/api/transfers/transfer-1', 'PATCH'],
  ]) assert.equal(isMicomercSyncTarget(target, method), true, `${method} ${target} should be allowed`)

  for (const [target, method] of [
    ['https://other.invalid/api/products', 'POST'],
    ['//other.invalid/api/products', 'POST'],
    ['https://micomerc.invalid/api/products', 'POST'],
    ['/api/test-db', 'GET'],
    ['/api/sales/123', 'DELETE'],
    ['/api/products', 'DELETE'],
    ['/api/products/12?target=other', 'PATCH'],
    ['/api/products\\12', 'PATCH'],
    ['/api/products/', 'POST'],
    ['/api/products/../sales', 'POST'],
    ['/api/products/%2Fsales', 'PATCH'],
  ]) assert.equal(isMicomercSyncTarget(target, method), false, `${method} ${target} should be blocked`)

  await assert.rejects(saveQueuedOperation({
    type: 'legacy.operation',
    label: 'Legacy operation',
    target: 'https://other.invalid/api/products',
    method: 'POST',
    payload: {},
  }), /Micomerc API endpoint/)
})
