#!/usr/bin/env node

// Copyright 2017 Cheng Zhao. All rights reserved.
// Use of this source code is governed by the license that can be found in the
// LICENSE file.

require('./common')

const fs     = require('fs')
const path   = require('path')
const marked = require('./libs/marked')
const yaml   = loadYaml()
const pug    = loadPug()
const hljs   = loadHighlight()

// Supported languages.
const langs = ['cpp', 'lua', 'js']

// Output dir.
const outputdir = path.join('out', 'Documents')

// Support highlighting in markdown.
marked.setOptions({
  highlight: (code) => hljs.highlightAuto(code).value
})

for (let lang of langs) {
  // Read API docs and generate HTML pages.
  const langdir = path.join(outputdir, 'api', lang)
  mkdir(langdir)
  const apis = fs.readdirSync('docs/api')
  for (let api of apis) {
    if (!api.endsWith('.yaml')) continue
    const name = path.basename(api, '.yaml')
    const doc = yaml.load(fs.readFileSync(`docs/api/${api}`))
    // Output JSON files.
    const langDoc = pruneDocTree(lang, doc)
    if (!langDoc)
      continue
    fs.writeFileSync(path.join(langdir, `${name}.json`),
                     JSON.stringify(langDoc, null, '  '))
    // Output HTML pages.
    const html = pug.renderFile('docs/template/api.pug', {
      doc: langDoc,
      markdown: marked,
      imarkdown: inlineMarkdown,
      filters: { 'css-minimize': cssMinimize },
    })
    fs.writeFileSync(path.join(langdir, `${name}.html`), html)
  }
}

// Load js-yaml from its browserify pack.
function loadYaml() {
  const vm = require('vm')
  const script = new vm.Script(fs.readFileSync(`${__dirname}/libs/yaml.js`))
  const sandbox = {}
  script.runInNewContext(sandbox)
  return sandbox.jsyaml
}

// Load pug.js from its browserify pack.
function loadPug() {
  const vm = require('vm')
  const script = new vm.Script(fs.readFileSync(`${__dirname}/libs/pug.js`))
  const sandbox = {fs: fs}
  script.runInNewContext(sandbox)
  return sandbox.require('pug')
}

// Load hightlight.js from its browserify pack.
function loadHighlight() {
  const vm = require('vm')
  const script = new vm.Script(fs.readFileSync(`${__dirname}/libs/highlight.js`))
  const sandbox = {}
  sandbox.window = sandbox
  script.runInNewContext(sandbox)
  return sandbox.hljs
}

// Make dir and ignore error.
function mkdir(dir) {
  if (fs.existsSync(dir)) return
  mkdir(path.dirname(dir))
  fs.mkdirSync(dir)
}

// Parse |doc| tree and only keep nodes for |lang|.
function pruneDocTree(lang, doc) {
  if (doc.lang && !doc.lang.includes(lang))
    return null

  doc = JSON.parse(JSON.stringify(doc))

  if (doc.inherit)
    doc.inherit = parseType(lang, doc.inherit)

  if (doc.lang_detail && doc.lang_detail[lang])
    doc.detail += '\n' + doc.lang_detail[lang]
  delete doc.lang_detail

  const categories = ['constructors', 'class_properties', 'class_methods',
                      'methods', 'events']
  for (let category of categories) {
    if (!doc[category]) continue
    let nodes = []
    for (let node of doc[category]) {
      if (!node.lang || (node.lang && node.lang.includes(lang)))
        nodes.push(pruneNode(lang, node))
    }
    if (nodes.length > 0)
      doc[category] = nodes
    else
      delete doc[category]
  }

  return doc
}

// Convert C++ representation to |lang| representation.
function pruneNode(lang, node) {
  node = JSON.parse(JSON.stringify(node))

  delete node.lang
  // Recursively prune the Dictionary type parameters.
  if (node.parameters) {
    for (let param in node.parameters) {
      let descriptor = node.parameters[param]
      if (descriptor.properties) {
        for (let i in descriptor.properties)
          descriptor.properties[i] = pruneNode(lang, descriptor.properties[i])
      }
    }
  }

  if (node.signature) {
    node.id = generateIdForSignature(node.signature)
    node.signature = parseSignature(lang, node.signature)
    if (node.parameters) {
      mergePrameters(node.signature, node.parameters)
      delete node.parameters
    }
  } else if (node.property) {
    node.id = parseParam('lua', node.property).name
    Object.assign(node, parseParam(lang, node.property))
    delete node.property
  } else if (node.callback) {
    node.id = generateIdForSignature(node.callback)
    node.callback = parseSignature(lang, node.callback)
  }

  return node
}

// Parse the C++ signature string.
function parseSignature(lang, str) {
  let signature = {}
  let match = str.match(/^(\w+)\((.*)\)$/)
  if (match) {
    // Constructor type.
    signature.name = match[1]
    signature.parameters = match[2]
  } else {
    match = str.match(/^(.*) (\w+)\((.*)\).*$/)
    if (match[1] != 'void')
      signature.returnType = parseType(lang, match[1])
    signature.name = match[2]
    signature.parameters = match[3]
  }
  signature.name = parseName(lang, signature.name)
  signature.parameters = parseParameters(lang, signature.parameters)
  if (lang == 'cpp') {
    signature.str = str
  } else {
    let parameters = signature.parameters.map((param) => param.name)
    signature.str = `${signature.name}(${parameters.join(', ')})`
  }
  return signature
}

// Parse parameters.
function parseParameters(lang, str) {
  if (str == '') return []
  let parameters = str.split(',').map(parseParam.bind(null, lang))
  return parameters
}

// Parse param.
function parseParam(lang, str) {
  let match = str.trim().match(/(.+) (\w+)/)
  return { type: parseType(lang, match[1]), name: parseName(lang, match[2]) }
}

// Convert method name from C++ to |lang|.
function parseName(lang, str) {
  if (lang == 'cpp')
    return str
  else if (lang == 'lua')
    return str.replace(/_/g, '').toLowerCase()
  else if (lang == 'js')
    return (str[0].toLowerCase() + str.substr(1)).replace(/_([a-z])/g, (m, w) => {
      return w.toUpperCase()
    })
}

// Convert type name from C++ to |lang|.
function parseType(lang, str) {
  // Strip C++ qualifiers.
  let type = str
  if (type.startsWith('const '))
    type = type.substr('const '.length)
  if (type.endsWith('*') || type.endsWith('&'))
    type = type.substr(0, type.length - 1)
  // No need to convert types for C++.
  if (lang == 'cpp') {
    let builtin = ['bool', 'float', 'std::string', 'char'].includes(type)
    return builtin ? { name: str } : { name: str, id: type.toLowerCase() }
  }
  // Convertbuilt-in types for differnt languages.
  let builtin = true
  if (lang == 'lua') {
    switch (type) {
      case 'bool': type = 'boolean'; break
      case 'float': type = 'number'; break
      case 'std::string': type = 'string'; break
      case 'char': type = 'string'; break
      case 'Dictionary': type = 'table'; break
      default: builtin = false
    }
  } else if (lang == 'js') {
    switch (type) {
      case 'bool': type = 'Boolean'; break
      case 'float': type = 'Number'; break
      case 'std::string': type = 'String'; break
      case 'char': type = 'String'; break
      case 'Dictionary': type = 'Object'; break
      default: builtin = false
    }
  }
  // Custom types usually have 1-to-1 maps.
  return builtin ? { name: type } : { name: type, id: type.toLowerCase() }
}

// Put the extra parameter descriptions into signature object.
function mergePrameters(signature, parameters) {
  for (let param of signature.parameters) {
    if (parameters[param.name])
      Object.assign(param, parameters[param.name])
  }
}

// Generate a readable ID from signature string.
function generateIdForSignature(str) {
  // Convert to all lowercase names.
  let signature = parseSignature('lua', str)
  let id = signature.name
  for (let param of signature.parameters)
    id += `-${param.name}`
  return id
}

// A simple CSS minimize function.
function cssMinimize(str) {
  let lines = str.split('\n')
  return lines.map((line) => line.trim()).join('')
}

// Strip p tag around markdown result.
function inlineMarkdown(str) {
  let markdown = marked(str)
  return markdown.substr(3, markdown.length - 8)
}