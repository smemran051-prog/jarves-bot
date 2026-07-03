const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');

// =====================================================
// কনফিগ (OCR লগ ট্যাব)
// =====================================================
const OCR_LOG_SHEET_ID = '1lsTcuBvuxPxUqDqD04sMPJI9Hjuo0V77teQ3dvPc7LQ';
const OCR_LOG_TAB_NAME = 'ocr_log';
const OCR_LOG_GID = '722670892';

// =====================================================
// ফিল্ড এক্সট্র্যাকশন (রেগেক্স + লেবেল)
// =====================================================
function extractFields(ocrText) {
  const fields = {
    serial: '',
    complaintDate: '',
    product: '',
    branch: '',
    salesDate: '',
    model: '',
    problem: '',
    remarks: '',
    type: 'default',
    rawText: ocrText.substring(0, 500) // প্রথম ৫০০ ক্যারেক্টার
  };

  const lines = ocrText.split('\n');

  // লাইন বাই লাইন স্ক্যান
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;

    // সিরিয়াল
    if (/serial|সিরিয়াল/i.test(l)) {
      const m = l.match(/[\dA-Z]{9,20}/);
      if (m) fields.serial = m[0];
      else fields.serial = l.replace(/serial|সিরিয়াল[:.\s-]*/gi, '').trim();
    }
    // কমপ্লেইন ডেট (Date কিন্তু Sales না)
    if (/date|তারিখ/i.test(l) && !/sales|বিক্রয়/i.test(l)) {
      const m = l.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
      if (m) fields.complaintDate = m[0];
      else fields.complaintDate = l.replace(/date|তারিখ[:.\s-]*/gi, '').trim();
    }
    // বিক্রয়ের তারিখ
    if (/sales.*date|বিক্রয়.*তারিখ/i.test(l)) {
      const m = l.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
      if (m) fields.salesDate = m[0];
      else fields.salesDate = l.replace(/sales.*date|বিক্রয়.*তারিখ[:.\s-]*/gi, '').trim();
    }
    // প্রোডাক্ট (মডেল না)
    if (/product|প্রোডাক্ট|পণ্য/i.test(l) && !/model|মডেল/i.test(l)) {
      fields.product = l.replace(/product|প্রোডাক্ট|পণ্য[:.\s-]*/gi, '').trim();
    }
    // মডেল
    if (/model|মডেল/i.test(l)) {
      fields.model = l.replace(/model|মডেল[:.\s-]*/gi, '').trim();
    }
    // ব্রাঞ্চ/ক্লায়েন্ট
    if (/branch|ব্রাঞ্চ|শাখা|client|ক্লায়েন্ট|customer/i.test(l)) {
      fields.branch = l.replace(/branch|ব্রাঞ্চ|শাখা|client|ক্লায়েন্ট|customer[:.\s-]*/gi, '').trim();
    }
    // সমস্যা
    if (/problem|সমস্যা|ত্রুটি|issue|fault/i.test(l)) {
      fields.problem = l.replace(/problem|সমস্যা|ত্রুটি|issue|fault[:.\s-]*/gi, '').trim();
    }
    // মন্তব্য
    if (/remarks|মন্তব্য|note/i.test(l)) {
      fields.remarks = l.replace(/remarks|মন্তব্য|note[:.\s-]*/gi, '').trim();
    }
  }

  // ফলব্যাক: পুরো টেক্সট থেকে সিরিয়াল ও তারিখ
  if (!fields.serial) {
    const globalSerial = ocrText.match(/[\dA-Z]{9,20}/);
    if (globalSerial) fields.serial = globalSerial[0];
  }
  if (!fields.complaintDate) {
    const globalDate = ocrText.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
    if (globalDate) fields.complaintDate = globalDate[0];
  }

  // ডিভাইস টাইপ ডিটেকশন
  const typeKeywords = {
    'ups_offline': ['ups', 'অফলাইন', 'offline', 'পাওয়ার', 'power', '650va', '1200va'],
    'ups_online': ['online', 'অনলাইন', 'network', 'internet'],
    'battery': ['battery', 'ব্যাটারি', 'charge', 'চার্জ'],
    'sound': ['sound', 'সাউন্ড', 'speaker', 'স্পিকার', 'audio'],
    'monitor': ['monitor', 'মনিটর', 'display', 'screen'],
    'printer': ['printer', 'প্রিন্টার']
  };
  for (const [type, keywords] of Object.entries(typeKeywords)) {
    if (keywords.some(kw => ocrText.toLowerCase().includes(kw))) {
      fields.type = type;
      break;
    }
  }

  return fields;
}

// =====================================================
// ocr_log শিটে ডেটা পাঠানো (CSV append)
// =====================================================
function appendToLog(fields) {
  const row = [
    new Date().toISOString(),
    fields.serial,
    fields.complaintDate,
    fields.product,
    fields.branch,
    fields.salesDate,
    fields.model,
    fields.problem,
    fields.remarks,
    fields.type,
    '' // image link placeholder
  ];
  // বর্তমানে কনসোলে লগ (ভবিষ্যতে Sheet API যোগ করা যাবে)
  console.log('📋 OCR LOG:', row.join(' | '));
}

// =====================================================
// মূল প্রসেসিং ফাংশন (ইঞ্জিন থেকে কল হবে)
// =====================================================
async function processImageMessage(msg, client) {
  try {
    if (!msg.hasMedia) return null;
    if (msg.type !== 'image' && msg.type !== 'document') return null;

    const media = await msg.downloadMedia();
    const tmpDir = path.join(process.env.TEMP || '/tmp', 'jarves_ocr');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    let text = '';

    // ইমেজ OCR
    if (msg.type === 'image') {
      const imgPath = path.join(tmpDir, `ocr_${Date.now()}.jpg`);
      fs.writeFileSync(imgPath, media.data, 'base64');
      const { data: { text: ocrText } } = await Tesseract.recognize(imgPath, 'eng+ben');
      text = ocrText;
      fs.unlinkSync(imgPath);
    }
    // পিডিএফ
    else if (msg.type === 'document') {
      const pdfPath = path.join(tmpDir, `ocr_${Date.now()}.pdf`);
      fs.writeFileSync(pdfPath, media.data, 'base64');
      const pdfData = await pdfParse(fs.readFileSync(pdfPath));
      text = pdfData.text;
      fs.unlinkSync(pdfPath);
    }

    if (!text.trim()) {
      console.log('⚠️ OCR empty text');
      return null;
    }

    // ফিল্ড এক্সট্র্যাক্ট
    const fields = extractFields(text);
    console.log('🔍 OCR Extracted Fields:', JSON.stringify(fields, null, 2));

    // লগে পাঠানো
    appendToLog(fields);

    // সিরিয়াল রিটার্ন (ইঞ্জিন সার্চ করবে)
    return fields.serial || null;

  } catch (e) {
    console.error('❌ OCR Error:', e.message);
    return null;
  }
}

// =====================================================
// এক্সপোর্ট
// =====================================================
module.exports = {
  name: 'OCR Ultra Pro Max',
  version: '3.0.0',
  process: processImageMessage
};