import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import {
  lastTwoLines,
  formatNotebookCellFull,
  extractUpload,
  capText,
  setRecognizeImage,
} from '../lib/extract.js'

test('lastTwoLines keeps the tail', () => {
  assert.equal(lastTwoLines('a\nb\nc\n'), 'b\nc')
  assert.equal(lastTwoLines('only'), 'only')
  assert.equal(lastTwoLines(''), '')
})

test('capText notes truncation', () => {
  const { text, truncated } = capText('abcdef', 3)
  assert.equal(truncated, true)
  assert.match(text, /^abc/)
  assert.equal(capText('hi', 10).truncated, false)
})

test('extractUpload reads utf-8 text files', async () => {
  const result = await extractUpload(Buffer.from('hello extract'), {
    name: 'notes.txt',
    mime: 'text/plain',
    limits: { maxExtractChars: 80_000, explainImages: false },
  })
  assert.equal(result.kind, 'text')
  assert.equal(result.text, 'hello extract')
  assert.equal(result.truncated, false)
})

test('extractUpload accepts a Node Buffer PDF without the unpdf Buffer error', async () => {
  const pdf = Buffer.from(`%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000276 00000 n 
0000000369 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
456
%%EOF
`)
  const result = await extractUpload(pdf, {
    name: 'hello.pdf',
    mime: 'application/pdf',
    limits: { maxExtractChars: 80_000 },
  })
  assert.doesNotMatch(result.text, /Uint8Array|rather than `Buffer`/)
  assert.equal(result.kind, 'pdf')
})

test('notebook preview keeps last two output lines; full cell dump is complete', async () => {
  const nb = {
    cells: [
      {
        cell_type: 'code',
        source: ['print(1)\n', 'print(2)\n', 'print(3)'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['line-a\n', 'line-b\n', 'line-c\n'] },
          { output_type: 'display_data', data: { 'image/png': 'AAAA', 'text/plain': '<Figure>' } },
        ],
      },
    ],
  }
  const result = await extractUpload(Buffer.from(JSON.stringify(nb)), {
    name: 'analysis.ipynb',
    mime: 'application/json',
    limits: { maxExtractChars: 80_000 },
  })
  assert.equal(result.kind, 'ipynb')
  assert.match(result.text, /print\(3\)/)
  assert.match(result.text, /line-b\nline-c/)
  assert.doesNotMatch(result.text, /line-a/)
  const full = formatNotebookCellFull(nb.cells[0], 0)
  assert.match(full, /line-a/)
  assert.match(full, /line-c/)
  assert.match(full, /image\/png omitted, 4 bytes/)
})

test('xlsx extractor emits sheet name and cell values', async () => {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Sales')
  sheet.addRow(['sku', 'qty'])
  sheet.addRow(['abc', 2])
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  const result = await extractUpload(buf, {
    name: 'sales.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    limits: { maxExtractChars: 80_000 },
  })
  assert.equal(result.kind, 'xlsx')
  assert.match(result.text, /Sales/)
  assert.match(result.text, /sku/)
  assert.match(result.text, /abc/)
})

test('pptx extractor pulls slide XML text', async () => {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Hello slide</a:t></p:sld>')
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  const result = await extractUpload(buf, {
    name: 'deck.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    limits: { maxExtractChars: 80_000 },
  })
  assert.equal(result.kind, 'pptx')
  assert.match(result.text, /Hello slide/)
})

test('image extractor uses OCR hook and skips explain when disabled', async () => {
  setRecognizeImage(async () => 'HELLO OCR')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1])
  const result = await extractUpload(png, {
    name: 'x.png',
    mime: 'image/png',
    limits: { maxExtractChars: 80_000, explainImages: false, ocrLanguages: 'eng' },
  })
  assert.equal(result.kind, 'image')
  assert.match(result.text, /HELLO OCR/)
  setRecognizeImage(null)
})
