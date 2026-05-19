const TreeSitter = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScriptLang = require('tree-sitter-typescript');
const Python = require('tree-sitter-python');
const Go = require('tree-sitter-go');
const Rust = require('tree-sitter-rust');
const Java = require('tree-sitter-java');
const CSharp = require('tree-sitter-c-sharp');

const EXTENSION_TO_LANGUAGE = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.sql': 'sql',
  '.css': 'css',
  // New text-based extensions
  '.json': 'text',
  '.yaml': 'text',
  '.yml': 'text',
  '.graphql': 'text',
  '.gql': 'text',
  '.md': 'text',
  '.toml': 'text',
  '.xml': 'text',
  '.html': 'text',
  '.scss': 'css',
  '.less': 'css',
  '.vue': 'text',
  '.svelte': 'text',
};

// Languages with tree-sitter AST support
const TREE_SITTER_LANGUAGES = new Set([
  'javascript',
  'typescript',
  'tsx',
  'python',
  'go',
  'rust',
  'java',
  'csharp',
]);

// Languages using regex fallback
const REGEX_LANGUAGES = new Set(['bash', 'sql', 'css', 'text']);

class Parser {
  constructor() {
    this.languages = {
      javascript: JavaScript,
      typescript: TypeScriptLang.typescript,
      tsx: TypeScriptLang.tsx,
      python: Python,
      go: Go,
      rust: Rust,
      java: Java,
      csharp: CSharp,
    };
    this._lastLang = null;
    this._parser = null;
  }

  _getParser(lang) {
    // Create fresh parser when language changes to avoid native binding corruption
    if (this._lastLang !== lang || !this._parser) {
      this._parser = new TreeSitter();
      this._parser.setLanguage(this.languages[lang]);
      this._lastLang = lang;
    }
    return this._parser;
  }

  detectLanguage(filePath) {
    const ext = '.' + filePath.split('.').pop();
    return EXTENSION_TO_LANGUAGE[ext] || null;
  }

  parse(filePath, content) {
    const lang = this.detectLanguage(filePath);
    if (!lang) return { symbols: [], imports: [] };

    if (TREE_SITTER_LANGUAGES.has(lang)) {
      return this._parseTreeSitter(filePath, content, lang);
    }
    if (REGEX_LANGUAGES.has(lang)) {
      return this._parseRegex(filePath, content, lang);
    }
    return { symbols: [], imports: [] };
  }

  _parseTreeSitter(filePath, content, lang) {
    if (!this.languages[lang]) return { symbols: [], imports: [] };

    const parser = this._getParser(lang);

    let tree;
    try {
      tree = parser.parse(content);
    } catch {
      return { symbols: [], imports: [] };
    }

    const symbols = [];
    const imports = [];

    this._walk(tree.rootNode, content, symbols, imports, null);

    // Build parent-child relationships: populate children arrays
    this._linkChildren(symbols);

    return { symbols, imports };
  }

  _walk(node, content, symbols, imports, parentScope) {
    if (!node) return;

    // Track whether this node defines a new scope for nested children
    let newScope = parentScope;
    // Set to true for nodes whose extractors already handle child iteration
    let skipChildRecurse = false;

    switch (node.type) {
      case 'function_declaration':
        this._extractFunction(node, content, symbols, parentScope);
        newScope = this._getNodeName(node) || parentScope;
        break;

      case 'lexical_declaration':
      case 'variable_declaration':
        this._extractVariableDecl(node, content, symbols, imports, parentScope);
        break;

      case 'class_declaration':
        if (this._lastLang === 'java') {
          this._extractJavaClass(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
          skipChildRecurse = true;
        } else if (this._lastLang === 'csharp') {
          this._extractCsClass(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
          skipChildRecurse = true;
        } else {
          this._extractClass(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
        }
        break;

      case 'expression_statement':
        this._extractExpressionImport(node, content, imports);
        this._extractRoute(node, content, symbols, parentScope);
        break;

      // TypeScript / Python import declarations
      case 'import_statement':
        this._extractImportStatement(node, imports);
        break;

      // TypeScript-specific: type aliases, interfaces, enums
      case 'type_alias_declaration':
        this._extractTypeAlias(node, content, symbols, parentScope);
        break;

      case 'interface_declaration':
        if (this._lastLang === 'java' || this._lastLang === 'csharp') {
          this._extractJavaCsInterface(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
          skipChildRecurse = true;
        } else {
          this._extractInterface(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
        }
        break;

      case 'enum_declaration':
        if (this._lastLang === 'java' || this._lastLang === 'csharp') {
          this._extractJavaCsEnum(node, content, symbols, parentScope);
          skipChildRecurse = true;
        } else {
          this._extractEnum(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
        }
        break;

      case 'method_definition':
        // Methods inside classes are already extracted by _extractClass.
        // Set scope for recursion into method bodies.
        newScope = this._getNodeName(node) || parentScope;
        break;

      case 'arrow_function':
      case 'function_expression':
        // Anonymous arrow functions / function expressions encountered during walk.
        // Named ones are handled via variable_declaration. Just allow recursion.
        break;

      case 'variable_declarator': {
        // When a variable_declarator has an arrow_function or function_expression value,
        // use the variable name as scope for recursion into the function body.
        const varName = node.childForFieldName('name');
        const varValue = node.childForFieldName('value');
        if (
          varName &&
          varValue &&
          (varValue.type === 'arrow_function' || varValue.type === 'function_expression')
        ) {
          newScope = varName.text || parentScope;
        }
        break;
      }

      // --- Python-specific node types ---
      case 'class_definition':
        this._extractPyClass(node, content, symbols, parentScope);
        newScope = this._getNodeName(node) || parentScope;
        skipChildRecurse = true; // _extractPyClass handles methods
        break;

      case 'function_definition':
        this._extractPyFunction(node, content, symbols, parentScope);
        newScope = this._getNodeName(node) || parentScope;
        break;

      case 'decorated_definition': {
        // decorated_definition wraps a function_definition or class_definition
        const definition = node.childForFieldName('definition');
        if (definition) {
          const decorators = [];
          for (let i = 0; i < node.childCount; i++) {
            if (node.child(i).type === 'decorator') {
              decorators.push(node.child(i).text);
            }
          }
          if (definition.type === 'function_definition') {
            this._extractPyFunction(definition, content, symbols, parentScope, decorators);
            newScope = this._getNodeName(definition) || parentScope;
          } else if (definition.type === 'class_definition') {
            this._extractPyClass(definition, content, symbols, parentScope, decorators);
            newScope = this._getNodeName(definition) || parentScope;
          }
        }
        skipChildRecurse = true; // handled above
        break;
      }

      case 'import_from_statement':
        this._extractPyFromImport(node, imports);
        break;

      // --- Go-specific node types ---
      case 'method_declaration':
        if (this._lastLang === 'java') {
          this._extractJavaMethod(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
        } else if (this._lastLang === 'csharp') {
          this._extractCsMethod(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
        } else {
          this._extractGoMethod(node, content, symbols);
          newScope = this._getNodeName(node) || parentScope;
        }
        break;

      case 'type_declaration':
        this._extractGoTypeDecl(node, content, symbols, parentScope);
        break;

      case 'const_declaration':
      case 'var_declaration':
        this._extractGoVarConst(node, content, symbols, parentScope);
        break;

      case 'import_declaration':
        if (this._lastLang === 'java') {
          this._extractJavaImport(node, imports);
        } else {
          this._extractGoImport(node, imports);
        }
        break;

      // --- Rust-specific node types ---
      case 'function_item':
        this._extractRustFunction(node, content, symbols, parentScope);
        newScope = this._getNodeName(node) || parentScope;
        break;

      case 'impl_item':
        this._extractRustImpl(node, content, symbols);
        newScope = this._getRustImplName(node) || parentScope;
        skipChildRecurse = true; // _extractRustImpl handles methods
        break;

      case 'struct_item':
        this._extractRustStruct(node, content, symbols, parentScope);
        break;

      case 'enum_item':
        this._extractRustEnum(node, content, symbols, parentScope);
        skipChildRecurse = true; // _extractRustEnum handles variants
        break;

      case 'trait_item':
        this._extractRustTrait(node, content, symbols, parentScope);
        newScope = this._getNodeName(node) || parentScope;
        skipChildRecurse = true; // _extractRustTrait handles methods
        break;

      case 'type_item':
        this._extractRustTypeAlias(node, content, symbols, parentScope);
        break;

      case 'const_item':
      case 'static_item':
        this._extractRustConstStatic(node, content, symbols, parentScope);
        break;

      case 'macro_definition':
        this._extractRustMacro(node, content, symbols, parentScope);
        break;

      case 'use_declaration':
        this._extractRustUse(node, imports);
        break;

      // --- Java-specific node types ---
      case 'annotation_type_declaration':
        this._extractJavaAnnotationType(node, content, symbols, parentScope);
        break;

      case 'constructor_declaration':
        if (this._lastLang === 'java') {
          this._extractJavaConstructor(node, content, symbols, parentScope);
        } else if (this._lastLang === 'csharp') {
          this._extractCsConstructor(node, content, symbols, parentScope);
        }
        break;

      case 'field_declaration':
        if (this._lastLang === 'java') {
          this._extractJavaField(node, content, symbols, parentScope);
        }
        break;

      // --- C#-specific node types ---
      case 'namespace_declaration':
        this._extractCsNamespace(node, content, symbols, parentScope);
        newScope = this._getCsNamespaceName(node) || parentScope;
        skipChildRecurse = true;
        break;

      case 'struct_declaration':
        if (this._lastLang === 'csharp') {
          this._extractCsStruct(node, content, symbols, parentScope);
          newScope = this._getNodeName(node) || parentScope;
          skipChildRecurse = true;
        }
        break;

      case 'property_declaration':
        if (this._lastLang === 'csharp') {
          this._extractCsProperty(node, content, symbols, parentScope);
        }
        break;

      case 'using_directive':
        if (this._lastLang === 'csharp') {
          this._extractCsUsing(node, imports);
        }
        break;
    }

    // Skip recursion for nodes whose extractors already handle child iteration
    if (skipChildRecurse) return;

    // Recurse into children -- we now recurse into ALL node types to find nested symbols.
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      // For nodes that define a scope, pass the new scope to children
      if (
        node.type === 'function_declaration' ||
        node.type === 'class_declaration' ||
        node.type === 'arrow_function' ||
        node.type === 'method_definition' ||
        node.type === 'function_expression' ||
        node.type === 'interface_declaration' ||
        node.type === 'enum_declaration' ||
        node.type === 'variable_declarator' ||
        // Python scope nodes
        node.type === 'class_definition' ||
        node.type === 'function_definition' ||
        node.type === 'decorated_definition' ||
        // Go scope nodes
        node.type === 'method_declaration' ||
        // Rust scope nodes
        node.type === 'impl_item' ||
        node.type === 'trait_item' ||
        node.type === 'function_item' ||
        // Java/C# scope nodes
        node.type === 'class_declaration' ||
        node.type === 'interface_declaration' ||
        node.type === 'enum_declaration' ||
        node.type === 'constructor_declaration' ||
        node.type === 'namespace_declaration' ||
        node.type === 'struct_declaration'
      ) {
        this._walk(child, content, symbols, imports, newScope);
      } else {
        this._walk(child, content, symbols, imports, parentScope);
      }
    }
  }

  _getNodeName(node) {
    const nameNode = node.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }

  _extractFunction(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const isAsync = node.children.some((c) => c.type === 'async');

    symbols.push({
      name: nameNode.text,
      kind: 'function',
      signature: this._getSignature(node, content),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: isAsync,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractVariableDecl(node, content, symbols, imports, parentScope) {
    for (let i = 0; i < node.childCount; i++) {
      const declarator = node.child(i);
      if (declarator.type !== 'variable_declarator') continue;

      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');

      if (!nameNode || !valueNode) continue;

      if (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression') {
        const isAsync = valueNode.children.some((c) => c.type === 'async');
        const name = nameNode.type === 'identifier' ? nameNode.text : null;
        if (name) {
          symbols.push({
            name,
            kind: 'function',
            signature: `${name}(${this._getParams(valueNode)})`,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: false,
            async: isAsync,
            parentClass: parentScope || null,
            children: [],
          });
        }
      }

      if (valueNode.type === 'call_expression') {
        this._extractRequire(nameNode, valueNode, node, imports);
      }
    }
  }

  _extractRequire(nameNode, callNode, declNode, imports) {
    const funcNode = callNode.childForFieldName('function');
    if (!funcNode || funcNode.text !== 'require') return;

    const args = callNode.childForFieldName('arguments');
    if (!args || args.childCount < 2) return;

    let source = null;
    for (let i = 0; i < args.childCount; i++) {
      const arg = args.child(i);
      if (arg.type === 'string') {
        source = arg.text.replace(/^['"`]|['"`]$/g, '');
        break;
      }
    }
    if (!source) return;

    let identifiers = [];
    if (nameNode.type === 'object_pattern') {
      for (let i = 0; i < nameNode.childCount; i++) {
        const child = nameNode.child(i);
        if (
          child.type === 'shorthand_property_identifier_pattern' ||
          child.type === 'shorthand_property_identifier'
        ) {
          identifiers.push(child.text);
        } else if (child.type === 'pair_pattern') {
          const val = child.childForFieldName('value');
          if (val) identifiers.push(val.text);
        }
      }
    } else if (nameNode.type === 'identifier') {
      identifiers = [nameNode.text];
    }

    imports.push({ source, identifiers, line: declNode.startPosition.row + 1 });
  }

  _extractExpressionImport(node, content, imports) {
    // Standalone require() — skip for now
  }

  _extractRoute(node, content, symbols, parentScope) {
    // Look for Express route registrations: router.get('/path', handler)
    // node is an expression_statement; its first child should be a call_expression
    const callExpr = node.childCount > 0 ? node.child(0) : null;
    if (!callExpr || callExpr.type !== 'call_expression') return;

    const callee = callExpr.childForFieldName('function');
    if (!callee || callee.type !== 'member_expression') return;

    // Check method name is an HTTP verb
    const methodNode = callee.childForFieldName('property');
    if (!methodNode) return;
    const methodName = methodNode.text;
    const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
    if (!HTTP_METHODS.has(methodName)) return;

    // Check the object is router/app/Router (common Express patterns)
    const objectNode = callee.childForFieldName('object');
    if (!objectNode) return;
    // Accept identifiers like router, app, or member expressions like this.router
    if (objectNode.type !== 'identifier' && objectNode.type !== 'member_expression') return;

    // Extract arguments
    const argsNode = callExpr.childForFieldName('arguments');
    if (!argsNode) return;

    // First argument must be a string literal (the route path)
    let pathArg = null;
    let handlerNode = null;

    for (let i = 0; i < argsNode.childCount; i++) {
      const arg = argsNode.child(i);
      // Skip commas and parens
      if (arg.type === ',' || arg.type === '(' || arg.type === ')') continue;

      if (!pathArg) {
        // First real argument should be the path string
        if (arg.type === 'string' || arg.type === 'template_string') {
          pathArg = arg.text.replace(/^['"`]|['"`]$/g, '');
        } else {
          return; // First arg isn't a string — not a route pattern we handle
        }
      } else {
        // Subsequent arguments: look for the handler callback
        if (arg.type === 'arrow_function' || arg.type === 'function_expression') {
          handlerNode = arg;
        }
      }
    }

    if (!pathArg || !handlerNode) return;

    const httpMethod = methodName.toUpperCase();
    const routeName = `${httpMethod} ${pathArg}`;

    symbols.push({
      name: routeName,
      kind: 'route',
      signature: routeName,
      startLine: handlerNode.startPosition.row + 1,
      endLine: handlerNode.endPosition.row + 1,
      exported: false,
      async: handlerNode.children.some((c) => c.type === 'async'),
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractTsImport(node, imports) {
    // import { x } from 'y' or import x from 'y'
    const sourceNode = node.childForFieldName('source');
    if (!sourceNode) return;
    const source = sourceNode.text.replace(/^['"`]|['"`]$/g, '');

    const identifiers = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'import_clause') {
        // Walk import clause for identifiers
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec.type === 'identifier') {
            identifiers.push(spec.text);
          } else if (spec.type === 'named_imports') {
            for (let k = 0; k < spec.childCount; k++) {
              const named = spec.child(k);
              if (named.type === 'import_specifier') {
                const nameNode = named.childForFieldName('name');
                if (nameNode) identifiers.push(nameNode.text);
              }
            }
          }
        }
      }
    }

    imports.push({ source, identifiers, line: node.startPosition.row + 1 });
  }

  _extractClass(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'class',
      signature: `class ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'method_definition') {
          const methodName = member.childForFieldName('name');
          if (methodName) {
            const isAsync = member.children.some((c) => c.type === 'async');
            symbols.push({
              name: methodName.text,
              kind: 'method',
              signature: `${methodName.text}(${this._getParams(member)})`,
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              exported: false,
              async: isAsync,
              parentClass: nameNode.text,
              children: [],
            });
          }
        }
      }
    }
  }

  // --- TypeScript-specific extractors ---

  _extractTypeAlias(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'type',
      signature: this._getSignature(node, content),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractInterface(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'interface',
      signature: `interface ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract interface methods/properties
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'method_signature' || member.type === 'property_signature') {
          const memberName = member.childForFieldName('name');
          if (memberName) {
            const kind = member.type === 'method_signature' ? 'method' : 'property';
            symbols.push({
              name: memberName.text,
              kind,
              signature: member.text.replace(/;$/, '').trim(),
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              exported: false,
              async: false,
              parentClass: nameNode.text,
              children: [],
            });
          }
        }
      }
    }
  }

  _extractEnum(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'enum',
      signature: `enum ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract enum members
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (
          member.type === 'enum_member' ||
          member.type === 'enum_assignment' ||
          member.type === 'property_identifier'
        ) {
          const memberName =
            member.childForFieldName('name') ||
            member.children?.find((c) => c.type === 'property_identifier') ||
            member;
          const name = memberName.text;
          if (name && name !== ',' && name !== '{' && name !== '}') {
            symbols.push({
              name,
              kind: 'enum_member',
              signature: member.text.trim(),
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              exported: false,
              async: false,
              parentClass: nameNode.text,
              children: [],
            });
          }
        }
      }
    }
  }

  // --- Python-specific extractors ---

  _extractPyClass(node, content, symbols, parentScope, decorators = []) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const sig = decorators.length
      ? `${decorators.join('\n')}\nclass ${nameNode.text}`
      : `class ${nameNode.text}`;

    symbols.push({
      name: nameNode.text,
      kind: 'class',
      signature: sig,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract methods from the class body
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'function_definition') {
          this._extractPyFunction(member, content, symbols, nameNode.text);
        } else if (member.type === 'decorated_definition') {
          const def = member.childForFieldName('definition');
          if (def && def.type === 'function_definition') {
            const decos = [];
            for (let j = 0; j < member.childCount; j++) {
              if (member.child(j).type === 'decorator') {
                decos.push(member.child(j).text);
              }
            }
            this._extractPyFunction(def, content, symbols, nameNode.text, decos);
          }
        }
      }
    }
  }

  _extractPyFunction(node, content, symbols, parentScope, decorators = []) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const isAsync = node.children.some((c) => c.type === 'async');
    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';

    // Determine if it's a method (inside a class) by checking parentScope
    const kind = parentScope ? 'method' : 'function';

    const sig = decorators.length
      ? `${decorators.join('\n')}\ndef ${nameNode.text}(${paramText})`
      : `def ${nameNode.text}(${paramText})`;

    symbols.push({
      name: nameNode.text,
      kind,
      signature: sig,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: isAsync,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractPyFromImport(node, imports) {
    // from module import name1, name2
    const moduleNode = node.childForFieldName('module_name');
    if (!moduleNode) return;
    const source = moduleNode.text;

    const identifiers = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'dotted_name' && child !== moduleNode) {
        identifiers.push(child.text);
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) identifiers.push(nameNode.text);
      }
    }

    imports.push({ source, identifiers, line: node.startPosition.row + 1 });
  }

  // Handles both TS import_statement and Python import_statement
  _extractImportStatement(node, imports) {
    // TS: import { x } from 'y' -- has a 'source' field
    const sourceNode = node.childForFieldName('source');
    if (sourceNode) {
      // TypeScript-style import
      this._extractTsImport(node, imports);
      return;
    }

    // Python: import os, import os.path -- has a 'name' field with dotted_name
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      const identifiers = [nameNode.text];
      // Check for additional imported names (import os, sys)
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === 'dotted_name' && child !== nameNode) {
          identifiers.push(child.text);
        }
      }
      imports.push({
        source: nameNode.text,
        identifiers,
        line: node.startPosition.row + 1,
      });
    }
  }

  // --- Go-specific extractors ---

  _extractGoMethod(node, content, symbols) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    // Extract the receiver type name
    const receiver = node.childForFieldName('receiver');
    let receiverType = null;
    if (receiver) {
      for (let i = 0; i < receiver.childCount; i++) {
        const param = receiver.child(i);
        if (param.type === 'parameter_declaration') {
          const typeNode = param.childForFieldName('type');
          if (typeNode) {
            // Strip pointer (*) to get the base type name
            receiverType = typeNode.text.replace(/^\*/, '');
          }
        }
      }
    }

    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';
    const result = node.childForFieldName('result');
    const sig = result
      ? `func (${receiver ? receiver.text.replace(/^\(|\)$/g, '') : ''}) ${nameNode.text}(${paramText}) ${result.text}`
      : `func (${receiver ? receiver.text.replace(/^\(|\)$/g, '') : ''}) ${nameNode.text}(${paramText})`;

    symbols.push({
      name: nameNode.text,
      kind: 'method',
      signature: sig,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: receiverType || null,
      children: [],
    });
  }

  _extractGoTypeDecl(node, content, symbols, parentScope) {
    // type_declaration contains type_spec children
    for (let i = 0; i < node.childCount; i++) {
      const spec = node.child(i);
      if (spec.type !== 'type_spec') continue;

      const nameNode = spec.childForFieldName('name');
      const typeNode = spec.childForFieldName('type');
      if (!nameNode) continue;

      let kind = 'type';
      let sig = `type ${nameNode.text}`;

      if (typeNode) {
        if (typeNode.type === 'struct_type') {
          kind = 'class'; // struct as class equivalent
          sig = `type ${nameNode.text} struct`;
        } else if (typeNode.type === 'interface_type') {
          kind = 'interface';
          sig = `type ${nameNode.text} interface`;

          // Extract interface method signatures
          for (let j = 0; j < typeNode.childCount; j++) {
            const member = typeNode.child(j);
            if (member.type === 'method_elem') {
              const methodName = member.childForFieldName('name');
              if (methodName) {
                const params = member.childForFieldName('parameters');
                const result = member.childForFieldName('result');
                const methodSig = result
                  ? `${methodName.text}(${params ? params.text.replace(/^\(|\)$/g, '') : ''}) ${result.text}`
                  : `${methodName.text}(${params ? params.text.replace(/^\(|\)$/g, '') : ''})`;
                symbols.push({
                  name: methodName.text,
                  kind: 'method',
                  signature: methodSig,
                  startLine: member.startPosition.row + 1,
                  endLine: member.endPosition.row + 1,
                  exported: false,
                  async: false,
                  parentClass: nameNode.text,
                  children: [],
                });
              }
            }
          }
        } else {
          sig = `type ${nameNode.text} ${typeNode.text}`;
        }
      }

      symbols.push({
        name: nameNode.text,
        kind,
        signature: sig,
        startLine: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
        exported: false,
        async: false,
        parentClass: parentScope || null,
        children: [],
      });
    }
  }

  _extractGoVarConst(node, content, symbols, parentScope) {
    const isConst = node.type === 'const_declaration';
    for (let i = 0; i < node.childCount; i++) {
      const spec = node.child(i);
      if (spec.type !== 'const_spec' && spec.type !== 'var_spec') continue;

      const nameNode = spec.childForFieldName('name');
      if (!nameNode) continue;

      symbols.push({
        name: nameNode.text,
        kind: isConst ? 'constant' : 'variable',
        signature: this._getSignature(spec, content),
        startLine: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
        exported: false,
        async: false,
        parentClass: parentScope || null,
        children: [],
      });
    }
  }

  _extractGoImport(node, imports) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'import_spec') {
        const pathNode = child.children.find((c) => c.type === 'interpreted_string_literal');
        if (pathNode) {
          const source = pathNode.text.replace(/^"|"$/g, '');
          imports.push({ source, identifiers: [], line: child.startPosition.row + 1 });
        }
      } else if (child.type === 'import_spec_list') {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec.type === 'import_spec') {
            const pathNode = spec.children.find((c) => c.type === 'interpreted_string_literal');
            if (pathNode) {
              const source = pathNode.text.replace(/^"|"$/g, '');
              imports.push({ source, identifiers: [], line: spec.startPosition.row + 1 });
            }
          }
        }
      }
    }
  }

  // --- Rust-specific extractors ---

  _extractRustFunction(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';
    const returnType = node.childForFieldName('return_type');
    const sig = returnType
      ? `fn ${nameNode.text}(${paramText}) -> ${returnType.text}`
      : `fn ${nameNode.text}(${paramText})`;

    // Check if this is inside an impl block
    const isMethod = parentScope != null;
    // Check for &self or &mut self in params to determine method vs associated function
    const hasSelf = params && params.text.includes('self');

    symbols.push({
      name: nameNode.text,
      kind: isMethod ? 'method' : 'function',
      signature: sig,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: node.children.some((c) => c.type === 'visibility_modifier'),
      async: node.children.some((c) => c.type === 'async'),
      parentClass: parentScope || null,
      children: [],
    });
  }

  _getRustImplName(node) {
    const typeNode = node.childForFieldName('type');
    return typeNode ? typeNode.text : null;
  }

  _extractRustImpl(node, content, symbols) {
    const typeNode = node.childForFieldName('type');
    if (!typeNode) return;

    const traitNode = node.childForFieldName('trait');
    const sig = traitNode ? `impl ${traitNode.text} for ${typeNode.text}` : `impl ${typeNode.text}`;

    symbols.push({
      name: typeNode.text,
      kind: 'impl',
      signature: sig,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: null,
      children: [],
    });

    // Extract methods from the impl body
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'function_item') {
          this._extractRustFunction(member, content, symbols, typeNode.text);
        }
      }
    }
  }

  _extractRustStruct(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'class', // struct as class equivalent
      signature: `struct ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: node.children.some((c) => c.type === 'visibility_modifier'),
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractRustEnum(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'enum',
      signature: `enum ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: node.children.some((c) => c.type === 'visibility_modifier'),
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract enum variants
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const variant = body.child(i);
        if (variant.type === 'enum_variant') {
          const variantName = variant.childForFieldName('name');
          if (variantName) {
            symbols.push({
              name: variantName.text,
              kind: 'enum_member',
              signature: variant.text.replace(/,$/, '').trim(),
              startLine: variant.startPosition.row + 1,
              endLine: variant.endPosition.row + 1,
              exported: false,
              async: false,
              parentClass: nameNode.text,
              children: [],
            });
          }
        }
      }
    }
  }

  _extractRustTrait(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'trait',
      signature: `trait ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: node.children.some((c) => c.type === 'visibility_modifier'),
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract trait method signatures
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'function_signature_item' || member.type === 'function_item') {
          const methodName = member.childForFieldName('name');
          if (methodName) {
            const params = member.childForFieldName('parameters');
            const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';
            const returnType = member.childForFieldName('return_type');
            const sig = returnType
              ? `fn ${methodName.text}(${paramText}) -> ${returnType.text}`
              : `fn ${methodName.text}(${paramText})`;
            symbols.push({
              name: methodName.text,
              kind: 'method',
              signature: sig,
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              exported: false,
              async: false,
              parentClass: nameNode.text,
              children: [],
            });
          }
        }
      }
    }
  }

  _extractRustTypeAlias(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'type',
      signature: this._getSignature(node, content),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: node.children.some((c) => c.type === 'visibility_modifier'),
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractRustConstStatic(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const isConst = node.type === 'const_item';
    symbols.push({
      name: nameNode.text,
      kind: isConst ? 'constant' : 'variable',
      signature: this._getSignature(node, content),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: node.children.some((c) => c.type === 'visibility_modifier'),
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractRustMacro(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'macro',
      signature: `macro_rules! ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractRustUse(node, imports) {
    // Extract the use path text, stripping 'use' and ';'
    const text = node.text
      .replace(/^use\s+/, '')
      .replace(/;$/, '')
      .trim();
    imports.push({
      source: text,
      identifiers: [],
      line: node.startPosition.row + 1,
    });
  }

  // --- Java-specific extractors ---

  _extractJavaClass(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'class',
      signature: `class ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'method_declaration') {
          this._extractJavaMethod(member, content, symbols, nameNode.text);
        } else if (member.type === 'constructor_declaration') {
          this._extractJavaConstructor(member, content, symbols, nameNode.text);
        } else if (member.type === 'field_declaration') {
          this._extractJavaField(member, content, symbols, nameNode.text);
        }
      }
    }
  }

  _extractJavaMethod(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';
    const typeNode = node.childForFieldName('type');
    const returnType = typeNode ? typeNode.text : 'void';

    symbols.push({
      name: nameNode.text,
      kind: 'method',
      signature: `${returnType} ${nameNode.text}(${paramText})`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractJavaConstructor(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';

    symbols.push({
      name: nameNode.text,
      kind: 'constructor',
      signature: `${nameNode.text}(${paramText})`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractJavaCsInterface(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'interface',
      signature: `interface ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract interface method declarations
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'method_declaration') {
          this._extractJavaMethod(member, content, symbols, nameNode.text);
        }
      }
    }
  }

  _extractJavaCsEnum(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'enum',
      signature: `enum ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Extract enum constants/members
    const body =
      this._lastLang === 'java'
        ? node.childForFieldName('body')
        : node.children.find((c) => c.type === 'enum_member_declaration_list');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'enum_constant' || member.type === 'enum_member_declaration') {
          const memberName =
            member.childForFieldName('name') ||
            member.children.find((c) => c.type === 'identifier');
          if (memberName) {
            symbols.push({
              name: memberName.text,
              kind: 'enum_member',
              signature: memberName.text,
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              exported: false,
              async: false,
              parentClass: nameNode.text,
              children: [],
            });
          }
        }
      }
    }
  }

  _extractJavaAnnotationType(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'annotation',
      signature: `@interface ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractJavaField(node, content, symbols, parentScope) {
    // field_declaration: has declarator children with name fields
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'property',
            signature: this._getSignature(node, content),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: false,
            async: false,
            parentClass: parentScope || null,
            children: [],
          });
        }
      }
    }
  }

  _extractJavaImport(node, imports) {
    // Find the scoped_identifier node for the import path
    let source = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'scoped_identifier') {
        source = child.text;
        break;
      }
    }
    if (!source) return;
    const identifiers = [source.split('.').pop()];
    imports.push({ source, identifiers, line: node.startPosition.row + 1 });
  }

  // --- C#-specific extractors ---

  _extractCsNamespace(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const nsName = nameNode.text;

    symbols.push({
      name: nsName,
      kind: 'namespace',
      signature: `namespace ${nsName}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    // Walk the namespace body, passing namespace name as scope
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        this._walk(body.child(i), content, symbols, [], nsName);
      }
    }
  }

  _getCsNamespaceName(node) {
    const nameNode = node.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }

  _extractCsClass(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'class',
      signature: `class ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'method_declaration') {
          this._extractCsMethod(member, content, symbols, nameNode.text);
        } else if (member.type === 'constructor_declaration') {
          this._extractCsConstructor(member, content, symbols, nameNode.text);
        } else if (member.type === 'property_declaration') {
          this._extractCsProperty(member, content, symbols, nameNode.text);
        }
      }
    }
  }

  _extractCsMethod(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';
    const typeNode = node.childForFieldName('returns');
    const returnType = typeNode ? typeNode.text : '';

    symbols.push({
      name: nameNode.text,
      kind: 'method',
      signature: returnType
        ? `${returnType} ${nameNode.text}(${paramText})`
        : `${nameNode.text}(${paramText})`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractCsConstructor(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const params = node.childForFieldName('parameters');
    const paramText = params ? params.text.replace(/^\(|\)$/g, '') : '';

    symbols.push({
      name: nameNode.text,
      kind: 'constructor',
      signature: `${nameNode.text}(${paramText})`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractCsStruct(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'class',
      signature: `struct ${nameNode.text}`,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });

    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (member.type === 'method_declaration') {
          this._extractCsMethod(member, content, symbols, nameNode.text);
        } else if (member.type === 'property_declaration') {
          this._extractCsProperty(member, content, symbols, nameNode.text);
        }
      }
    }
  }

  _extractCsProperty(node, content, symbols, parentScope) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const typeNode = node.childForFieldName('type');
    const typeName = typeNode ? typeNode.text : '';

    symbols.push({
      name: nameNode.text,
      kind: 'property',
      signature: typeName ? `${typeName} ${nameNode.text}` : nameNode.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      async: false,
      parentClass: parentScope || null,
      children: [],
    });
  }

  _extractCsUsing(node, imports) {
    // Find the name/qualified_name child for the using directive
    let source = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'identifier' || child.type === 'qualified_name') {
        // Skip 'using' keyword (first child)
        if (child.text !== 'using') {
          source = child.text;
          break;
        }
      }
    }
    if (!source) return;
    imports.push({
      source,
      identifiers: [source.split('.').pop()],
      line: node.startPosition.row + 1,
    });
  }

  // --- Parent-child linking ---

  _linkChildren(symbols) {
    const byName = new Map();
    // First pass: index all symbols by name, preferring top-level (no parent)
    // When duplicates exist at top level, prefer class/struct/trait/enum over impl
    for (const sym of symbols) {
      if (!sym.parentClass) {
        const existing = byName.get(sym.name);
        if (!existing) {
          byName.set(sym.name, sym);
        } else if (sym.kind !== 'impl' && existing.kind === 'impl') {
          // Prefer the non-impl symbol for child linking
          byName.set(sym.name, sym);
        }
      }
    }
    // Second pass: index remaining symbols that aren't yet indexed
    for (const sym of symbols) {
      if (!byName.has(sym.name)) {
        byName.set(sym.name, sym);
      }
    }

    for (const sym of symbols) {
      if (sym.parentClass) {
        const parent = byName.get(sym.parentClass);
        if (parent && parent !== sym && parent.children) {
          // Avoid duplicates (class methods are already added by _extractClass)
          const isDuplicate = parent.children.some(
            (c) => c.name === sym.name && c.startLine === sym.startLine,
          );
          if (!isDuplicate) {
            parent.children.push(sym);
          }
        }
      }
    }
  }

  _getSignature(node, content) {
    const lines = content.split('\n');
    const startLine = node.startPosition.row;
    return lines[startLine] ? lines[startLine].trim() : '';
  }

  _getParams(node) {
    const params = node.childForFieldName('parameters');
    if (!params) return '';
    return params.text.replace(/^\(|\)$/g, '');
  }

  // --- Regex fallback for non-tree-sitter languages ---

  _parseRegex(filePath, content, lang) {
    switch (lang) {
      case 'python':
        return this._parsePython(content);
      case 'bash':
        return this._parseBash(content);
      case 'sql':
        return this._parseSql(content);
      case 'css':
        return this._parseCss(content, filePath);
      case 'text':
        return this._parseText(filePath, content);
      default:
        return { symbols: [], imports: [] };
    }
  }

  _parsePython(content) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');

    lines.forEach((line, i) => {
      // Functions: def name(...)
      const funcMatch = line.match(/^(\s*)def\s+(\w+)\s*\(/);
      if (funcMatch) {
        const indent = funcMatch[1].length;
        symbols.push({
          name: funcMatch[2],
          kind: indent > 0 ? 'method' : 'function',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1, // Can't determine without indentation tracking
          exported: false,
          async: line.includes('async def'),
        });
      }

      // Classes: class Name:
      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }

      // Imports: import x / from x import y
      const importMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
      if (importMatch) {
        const source = importMatch[1] || importMatch[2].split(',')[0].trim();
        const identifiers = importMatch[2].split(',').map((s) => s.trim());
        imports.push({ source, identifiers, line: i + 1 });
      }
    });

    return { symbols, imports };
  }

  _parseBash(content) {
    const symbols = [];
    const lines = content.split('\n');
    const imports = [];

    lines.forEach((line, i) => {
      // function name() or name() {
      const funcMatch = line.match(/^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{?/);
      if (
        funcMatch &&
        !line.startsWith('#') &&
        funcMatch[1] !== 'if' &&
        funcMatch[1] !== 'for' &&
        funcMatch[1] !== 'while'
      ) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }

      // source ./file.sh
      const sourceMatch = line.match(/^(?:source|\.)\s+(.+)/);
      if (sourceMatch) {
        imports.push({ source: sourceMatch[1].trim(), identifiers: [], line: i + 1 });
      }
    });

    return { symbols, imports };
  }

  _parseSql(content) {
    const symbols = [];

    const fullContent = content;
    // CREATE TABLE name
    const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
    let m;
    while ((m = tablePattern.exec(fullContent)) !== null) {
      symbols.push({
        name: m[1],
        kind: 'class', // table as a "class" equivalent
        signature: `CREATE TABLE ${m[1]}`,
        startLine: fullContent.substring(0, m.index).split('\n').length,
        endLine: fullContent.substring(0, m.index).split('\n').length,
        exported: false,
        async: false,
      });
    }

    // CREATE VIEW name
    const viewPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(\w+)/gi;
    while ((m = viewPattern.exec(fullContent)) !== null) {
      symbols.push({
        name: m[1],
        kind: 'function', // view as a "function" equivalent
        signature: `CREATE VIEW ${m[1]}`,
        startLine: fullContent.substring(0, m.index).split('\n').length,
        endLine: fullContent.substring(0, m.index).split('\n').length,
        exported: false,
        async: false,
      });
    }

    return { symbols, imports: [] };
  }

  _parseCss(content, filePath) {
    // No cap — extract all top-level class and ID selectors
    const symbols = [];
    const lines = content.split('\n');

    lines.forEach((line, i) => {
      // Top-level class and ID selectors only (no nesting, no pseudo-selectors)
      const selectorMatch = line.match(/^([.#][\w-]+)\s*\{/);
      if (selectorMatch) {
        const name = selectorMatch[1];
        // Skip pseudo-selectors and nested selectors
        if (name.includes(':') || name.includes('>') || name.includes('+') || name.includes('~'))
          return;
        symbols.push({
          name,
          kind: 'class',
          signature: name,
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });

    return { symbols, imports: [] };
  }

  // --- Generic text-based parsers ---

  _parseText(filePath, content) {
    const ext = '.' + filePath.split('.').pop().toLowerCase();
    switch (ext) {
      case '.json':
        return this._parseJson(content);
      case '.yaml':
      case '.yml':
        return this._parseYaml(content);
      case '.graphql':
      case '.gql':
        return this._parseGraphql(content);
      case '.md':
        return this._parseMarkdown(content);
      case '.toml':
        return this._parseToml(content);
      case '.xml':
      case '.html':
        return this._parseXml(content);
      case '.vue':
      case '.svelte':
        return this._parseVueSvelte(content);
      default:
        return { symbols: [], imports: [] };
    }
  }

  _parseJson(content) {
    // Extract ALL keys at all nesting levels — no cap
    const symbols = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const keyMatch = line.match(/^\s*"([\w$-]+)"\s*:/);
      if (keyMatch) {
        symbols.push({
          name: keyMatch[1],
          kind: 'variable',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });
    return { symbols, imports: [] };
  }

  _parseYaml(content) {
    // Extract ALL keys at all nesting levels — no cap
    const symbols = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      // Any YAML key (at any indentation level)
      const keyMatch = line.match(/^(\s*)([\w$_-]+)\s*:/);
      if (keyMatch && !line.trimStart().startsWith('#')) {
        symbols.push({
          name: keyMatch[2],
          kind: 'variable',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });
    return { symbols, imports: [] };
  }

  _parseGraphql(content) {
    // No cap — extract all type/operation definitions
    const symbols = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      // type Name, input Name, enum Name, interface Name, union Name, scalar Name, directive Name
      const defMatch = line.match(/^(?:type|input|enum|interface|union|scalar|directive)\s+(\w+)/);
      if (defMatch) {
        symbols.push({
          name: defMatch[1],
          kind: 'class',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
      // query/mutation/subscription definitions
      const opMatch = line.match(/^(?:query|mutation|subscription)\s+(\w+)/);
      if (opMatch) {
        symbols.push({
          name: opMatch[1],
          kind: 'function',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });
    return { symbols, imports: [] };
  }

  _parseMarkdown(content) {
    // Quality filter: only # and ## headings — not a cap, a relevance filter
    const symbols = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      // Only ## headings (level 1 and 2) — skip ###, ####, etc.
      const headingMatch = line.match(/^(#{1,2})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        symbols.push({
          name: headingMatch[2].trim(),
          kind: level === 1 ? 'class' : 'function',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });
    return { symbols, imports: [] };
  }

  _parseToml(content) {
    // Extract ALL keys: section headers AND key=value pairs — no cap
    const symbols = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      // TOML section headers: [section] or [[array]]
      const sectionMatch = line.match(/^\[+([^\]]+)\]+/);
      if (sectionMatch) {
        symbols.push({
          name: sectionMatch[1].trim(),
          kind: 'class',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
        return;
      }
      // TOML key = value pairs
      const keyMatch = line.match(/^(\s*)([\w$_-]+)\s*=/);
      if (keyMatch && !line.trimStart().startsWith('#')) {
        symbols.push({
          name: keyMatch[2],
          kind: 'variable',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });
    return { symbols, imports: [] };
  }

  _parseXml(content) {
    // Quality filter: only <script> and <style> block boundaries
    // Parsing every <div> as a symbol is genuinely useless
    const symbols = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      // Only <script> and <style> block boundaries — no other tags as symbols
      const blockMatch = line.match(/<(script|style)\b[^>]*>/i);
      if (blockMatch) {
        symbols.push({
          name: blockMatch[1].toLowerCase(),
          kind: 'class',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: false,
          async: false,
        });
      }
    });
    return { symbols, imports: [] };
  }

  _parseVueSvelte(content) {
    // No cap — extract all symbols from script sections
    const symbols = [];
    const lines = content.split('\n');
    // Extract script section symbols using simple regex
    let inScript = false;
    lines.forEach((line, i) => {
      if (/<script/.test(line)) {
        inScript = true;
        return;
      }
      if (/<\/script>/.test(line)) {
        inScript = false;
        return;
      }
      if (!inScript) return;

      // function declarations
      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: line.includes('export'),
          async: line.includes('async'),
        });
      }
      // const/let arrow functions
      const arrowMatch = line.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
      if (arrowMatch) {
        symbols.push({
          name: arrowMatch[1],
          kind: 'function',
          signature: line.trim(),
          startLine: i + 1,
          endLine: i + 1,
          exported: line.includes('export'),
          async: line.includes('async'),
        });
      }
    });
    return { symbols, imports: [] };
  }
}

module.exports = Parser;
