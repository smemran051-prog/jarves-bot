const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const https = require('https');

// =====================================================
// কনফিগ (মেমোরি শিট থেকে লোড হবে)
// =====================================================
const CONFIG_SHEET_ID = '1lsTcuBvuxPxUqDqD04sMPJI9Hjuo0V77teQ3dvPc7LQ';
const CONFIG_SHEET_NAME = 'memory';
let ocrProviders = []; // { name, key }

// =====================================================
// মেমোরি শিট থেকে OCR প্রোভাইডার লোড
// =====================================================
function fetchOCRConfig() {
  return new Promise((resolve) => {
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CONFIG_SHEET_NAME)}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const rows = data.split('\n').filter(r => r.trim());
        const config = {};
        rows.forEach(row => {
          const cols = row.split(',').map(c => c.replace(/^"|"$/g, '').trim());
          if (cols.length >= 2) config[cols[0].toLowerCase()] = cols[1];
        });
        const providers = [];
        for (let i = 1; i <= 10; i++) {
          const name = config[`ocr_provider_${i}`];
          const key = config[`ocr_key_${i}`];
          if (name && key) {
            providers.push({ name: name.toLowerCase(), key });
          }
        }
        ocrProviders = providers;
        console.log(`🔌 OCR Providers loaded: ${providers.map(p => p.name).join(', ') || 'Tesseract only'}`);
        resolve();
      });
    }).on('error', () => resolve());
  });
}

// =====================================================
// সিরিয়াল এক্সট্র্যাক্টর (প্রোভাইডার থেকে আসা text-এর জন্য)
// =====================================================
function extractSerialSmart(text) {
  // 1. শব্দ ভিত্তিক চেক (2 দিয়ে শুরু, ১১-১৩ ডিজিট, শুধু সংখ্যা)
  const words = text.split(/[\s,.;:!?()\[\]{}\-|]+/);
  for (const word of words) {
    const cleaned = word.replace(/[^0-9]/g, '');
    if (cleaned.length < 11 || cleaned.length > 13) continue;
    if (!/^2/.test(cleaned)) continue;
    if (/^(01|8801|096)/.test(cleaned)) continue;
    if (/^(INV|CMP|SO|CHL)/i.test(cleaned)) continue;
    return cleaned;
  }

  // 2. পুরো টেক্সট থেকে ১১-১৩ ডিজিটের ধারাবাহিক সংখ্যা যা 2 দিয়ে শুরু
  const longNumber = text.match(/\d{11,13}/g);
  if (longNumber) {
    for (const num of longNumber) {
      if (/^2/.test(num) && !/^(01|8801|096)/.test(num)) {
        return num;
      }
    }
  }

  return null;
}

// =====================================================
// ফিল্ড এক্সট্র্যাকশন (লেবেল ভিত্তিক)
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
    rawText: ocrText.substring(0, 500)
  };
  const lines = ocrText.split('\n');
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (/serial|সিরিয়াল|S\/N/i.test(l)) {
      const m = l.match(/\d{11,20}/);
      if (m) fields.serial = m[0];
      else fields.serial = l.replace(/serial|সিরিয়াল|S\/N[:.\s-]*/gi, '').trim();
    }
    if (/date|তারিখ/i.test(l) && !/sales|বিক্রয়/i.test(l)) {
      const m = l.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
      if (m) fields.complaintDate = m[0];
      else fields.complaintDate = l.replace(/date|তারিখ[:.\s-]*/gi, '').trim();
    }
    if (/sales.*date|বিক্রয়.*তারিখ/i.test(l)) {
      const m = l.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
      if (m) fields.salesDate = m[0];
      else fields.salesDate = l.replace(/sales.*date|বিক্রয়.*তারিখ[:.\s-]*/gi, '').trim();
    }
    if (/product|প্রোডাক্ট|পণ্য/i.test(l) && !/model|মডেল/i.test(l)) {
      fields.product = l.replace(/product|প্রোডাক্ট|পণ্য[:.\s-]*/gi, '').trim();
    }
    if (/model|মডেল/i.test(l)) {
      fields.model = l.replace(/model|মডেল[:.\s-]*/gi, '').trim();
    }
    if (/branch|ব্রাঞ্চ|শাখা|client|ক্লায়েন্ট|customer/i.test(l)) {
      fields.branch = l.replace(/branch|ব্রাঞ্চ|শাখা|client|ক্লায়েন্ট|customer[:.\s-]*/gi, '').trim();
    }
    if (/problem|সমস্যা|ত্রুটি|issue|fault/i.test(l)) {
      fields.problem = l.replace(/problem|সমস্যা|ত্রুটি|issue|fault[:.\s-]*/gi, '').trim();
    }
    if (/remarks|মন্তব্য|note/i.test(l)) {
      fields.remarks = l.replace(/remarks|মন্তব্য|note[:.\s-]*/gi, '').trim();
    }
  }
  // ডিভাইস টাইপ
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
// Tesseract OCR (ছবি) – ওরিয়েন্টেশন ডিটেকশন সহ
// =====================================================
async function tesseractOCR(imageBuffer) {
  try {
    const sharp = require('sharp');
    const tmpDir = path.join(process.env.TEMP || '/tmp', 'jarves_ocr');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 0°, 90°, 180°, 270° – চারটি ঘূর্ণন চেষ্টা
    const rotations = [0, 90, 180, 270];
    let bestText = '';

    for (const angle of rotations) {
      const tmpImgPath = path.join(tmpDir, `rot_${angle}_${Date.now()}.jpg`);
      
      // নির্দিষ্ট কোণে ঘোরানো + প্রি-প্রসেস
      await sharp(imageBuffer)
        .rotate(angle)
        .grayscale()
        .normalize()
        .toFile(tmpImgPath);

      const { data: { text } } = await Tesseract.recognize(tmpImgPath, 'eng+ben');
      fs.unlinkSync(tmpImgPath);

      // সিরিয়াল পাওয়া গেলে এই টেক্সট-ই রিটার্ন
      const serial = extractSerialSmart(text);
      if (serial) {
        console.log(`   ✅ Tesseract found serial at ${angle}°: ${serial}`);
        return text;
      }
    }

    console.log('   ⚠️ Tesseract did not find serial in any rotation.');
    return '';
  } catch (e) {
    console.log('⚠️ Tesseract error: ' + e.message);
    return '';
  }
}
// =====================================================
// PDF টেক্সট এক্সট্র্যাকশন
// =====================================================
async function extractPdfText(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    return data.text || '';
  } catch (e) {
    console.log('⚠️ PDF parse error: ' + e.message);
    return '';
  }
}

// =====================================================
// Gemini Vision OCR
// =====================================================
async function geminiOCR(imageBase64, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: "Extract all text from this image exactly as it appears. Return the text verbatim." },
        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
      ]
    }]
  });
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.candidates && json.candidates[0]?.content?.parts?.[0]?.text) {
            resolve(json.candidates[0].content.parts[0].text);
          } else {
            resolve('');
          }
        } catch (e) {
          resolve('');
        }
      });
    });
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

// =====================================================
// ocr_log সংরক্ষণ (কনসোল)
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
    ''
  ];
  console.log('📋 OCR LOG:', row.join(' | '));
}

// =====================================================
// মূল প্রসেসিং (Tesseract → প্রোভাইডার ফলব্যাক)
// =====================================================
async function processImageMessage(msg, client) {
  try {
    if (!msg.hasMedia) return null;

    const media = await msg.downloadMedia();
    let text = '';
    let serial = null;

    // 1. ছবি হলে Tesseract চেষ্টা (ওরিয়েন্টেশন ঠিক করে)
    if (msg.type === 'image') {
      console.log('🔍 Trying Tesseract OCR with orientation detection...');
      const imageBuffer = Buffer.from(media.data, 'base64');
      text = await tesseractOCR(imageBuffer);
      serial = extractSerialSmart(text);
      if (serial) {
        console.log(`✅ Serial found: ${serial}`);
      }
    }

    // 2. পিডিএফ হলে pdf-parse
    if (!serial && msg.type === 'document') {
      console.log('📄 Extracting PDF text...');
      const pdfBuffer = Buffer.from(media.data, 'base64');
      text = await extractPdfText(pdfBuffer);
      serial = extractSerialSmart(text);
    }

    // 3. সিরিয়াল না পেলে প্রোভাইডার ফলব্যাক (Gemini ইত্যাদি)
    if (!serial && msg.type === 'image') {
      console.log('⚠️ Tesseract failed to find serial, trying providers...');
      for (const provider of ocrProviders) {
        console.log(`🔍 Trying ${provider.name}...`);
        if (provider.name === 'gemini') {
          text = await geminiOCR(media.data, provider.key);
          serial = extractSerialSmart(text);
          if (serial) {
            console.log(`✅ ${provider.name} found serial: ${serial}`);
            break;
          }
          console.log(`⚠️ ${provider.name} failed`);
        } else {
          // ভবিষ্যতে অন্যান্য প্রোভাইডার
          continue;
        }
      }
    }

    // 4. ফিল্ড বের করে লগ
    const fields = extractFields(text || '');
    if (serial) fields.serial = serial;
    console.log('🔍 OCR Fields:', JSON.stringify(fields, null, 2));
    appendToLog(fields);

    return serial || null;

  } catch (e) {
    console.error('❌ OCR Error:', e.message);
    return null;
  }
}

// =====================================================
// মডিউল এক্সপোর্ট
// =====================================================
module.exports = {
  name: 'OCR Ultra Pro Max',
  version: '4.3.0',
  process: processImageMessage,
  onReady: async function(client, config) {
    await fetchOCRConfig();
    console.log('✅ Bogie 2 (OCR) ready');
  }
};