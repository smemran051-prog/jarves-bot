// =====================================================
// 🚃 BOGIE 1: Google Sheet Manager (Public Sheet - No Auth)
// =====================================================

const https = require('https');

// =====================================================
// SHEET SOURCES
// =====================================================
let sheetSources = [
  {
    id: '16_zjNAu2cQ5Dqj4ijU4fnBe_Gt7iTodCjhkjfQNBQD0',
    name: 'Power Guard Offline UPS',
    type: 'ups_offline',
    gid: '0',
    keywords: ['ups', 'অফলাইন', 'offline', 'power', 'পাওয়ার', '650', '1200', 'classic', 'volt', 'prolink']
  }
];

// =====================================================
// INIT
// =====================================================
function initSheetAPI() {
  console.log('✅ Bogie 1: Ready (Public Sheet Mode)');
  console.log(`📋 ${sheetSources.length} sheet(s) configured`);
  if (sheetSources.length > 0) {
    console.log(`   Sheet: ${sheetSources[0].name} (${sheetSources[0].id})`);
  }
  return true;
}

// =====================================================
// DOWNLOAD SHEET AS CSV
// =====================================================
function downloadSheetCSV(sheetId, gid = '0') {
  return new Promise((resolve, reject) => {
    const sheetName = 'Sheet1';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => { data += chunk; });
      
      res.on('end', () => {
        // CSV parse with quote handling
        const rows = [];
        let currentRow = [];
        let currentField = '';
        let inQuotes = false;
        
        for (let i = 0; i < data.length; i++) {
          const char = data[i];
          const nextChar = data[i + 1];
          
          if (inQuotes) {
            if (char === '"' && nextChar === '"') { currentField += '"'; i++; }
            else if (char === '"') { inQuotes = false; }
            else { currentField += char; }
          } else {
            if (char === '"') { inQuotes = true; }
            else if (char === ',') { currentRow.push(currentField.trim()); currentField = ''; }
            else if (char === '\n' || char === '\r') {
              if (currentField || currentRow.length > 0) {
                currentRow.push(currentField.trim());
                if (currentRow.some(f => f !== '')) rows.push(currentRow);
                currentRow = [];
                currentField = '';
              }
              if (char === '\r' && nextChar === '\n') i++;
            } else { currentField += char; }
          }
        }
        
        if (currentField || currentRow.length > 0) {
          currentRow.push(currentField.trim());
          if (currentRow.some(f => f !== '')) rows.push(currentRow);
        }
        
        console.log(`📋 Downloaded: ${sheetId} (${rows.length} rows)`);
        resolve(rows);
      });
      
    }).on('error', (err) => {
      console.error(`❌ Download failed: ${sheetId} - ${err.message}`);
      resolve(null);
    });
  });
}

// =====================================================
// DYNAMIC COLUMN DETECTION
// =====================================================
function detectColumns(headers) {
  const map = {};
  
  headers.forEach((h, i) => {
    const header = String(h || '').toLowerCase().trim();
    
    // Exact order from your sheet:
    // Service center In Date | Clients Name | Sales Date | Product Name/Model | Serial No | Box | Product Status | Lab out Date | Remarks
    
    if (/service|in.*date|আসার|গ্রহণ/i.test(header) && !header.includes('sales') && !header.includes('out')) map.inDateCol = i;
    else if (/client|customer|ক্লায়েন্ট|গ্রাহক/i.test(header) && !header.includes('name') === false) map.clientCol = i;
    else if (/sales|বিক্রির/i.test(header)) map.salesDateCol = i;
    else if (/product|প্রোডাক্ট|পণ্য|model/i.test(header) && !header.includes('status')) map.productCol = i;
    else if (/serial|সিরিয়াল|ক্রমিক/i.test(header)) map.serialCol = i;
    else if (/^box$/i.test(header.trim())) map.boxCol = i;
    else if (/status|স্ট্যাটাস|অবস্থা|product.*status/i.test(header)) map.statusCol = i;
    else if (/lab.*out|out.*date|বের|delivery/i.test(header)) map.labOutCol = i;
    else if (/remarks|মন্তব্য|কাজ|work|solution/i.test(header)) map.remarksCol = i;
  });
  
  // Fallback for your specific sheet (column order A to I)
  if (map.inDateCol === undefined) map.inDateCol = 0;    // A: Service center In Date
  if (map.clientCol === undefined) map.clientCol = 1;    // B: Clients Name
  if (map.salesDateCol === undefined) map.salesDateCol = 2; // C: Sales Date
  if (map.productCol === undefined) map.productCol = 3;  // D: Product Name/Model
  if (map.serialCol === undefined) map.serialCol = 4;    // E: Serial No
  if (map.boxCol === undefined) map.boxCol = 5;          // F: Box
  if (map.statusCol === undefined) map.statusCol = 6;    // G: Product Status
  if (map.labOutCol === undefined) map.labOutCol = 7;    // H: Lab out Date
  if (map.remarksCol === undefined) map.remarksCol = 8;  // I: Remarks
  
  return map;
}

// =====================================================
// PARSE SHEET DATA
// =====================================================
function parseSheetData(rows) {
  if (!rows || rows.length < 1) return { headers: [], entries: [] };
  
  // Find header row - looks for "Serial No"
  let headerRowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.some(cell => /serial/i.test(String(cell)))) {
      headerRowIndex = i;
      break;
    }
  }
  
  if (headerRowIndex === -1) {
    console.log('⚠️ No header row found');
    return { headers: [], entries: [] };
  }
  
  const headers = rows[headerRowIndex];
  const colMap = detectColumns(headers);
  const serialCol = colMap.serialCol;
  
  console.log(`📌 Header at row ${headerRowIndex + 1}, Serial column: ${serialCol}`);
  
  // Only rows with serial numbers
  const entries = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const serialValue = String(row[serialCol] || '').trim();
    
    if (!serialValue) continue;
    
    entries.push({
      rowIndex: i + 1,
      serial: serialValue,
      inDate: row[colMap.inDateCol] || '',
      client: row[colMap.clientCol] || '',
      salesDate: row[colMap.salesDateCol] || '',
      product: row[colMap.productCol] || '',
      box: row[colMap.boxCol] || '',
      status: row[colMap.statusCol] || '',
      labOut: row[colMap.labOutCol] || '',
      remarks: row[colMap.remarksCol] || ''
    });
  }
  
  console.log(`📊 Parsed: ${entries.length} entries with serial numbers`);
  return { headers, colMap, entries };
}

// =====================================================
// SEARCH IN SHEET
// =====================================================
async function searchInSheet(sheetId, serialNumber, gid = '0') {
  const rows = await downloadSheetCSV(sheetId, gid);
  if (!rows) return null;
  
  const { entries } = parseSheetData(rows);
  
  const matches = entries.filter(e => 
    e.serial.toLowerCase() === serialNumber.toLowerCase()
  );
  
  if (matches.length === 0) return null;
  
  return {
    sheetId,
    serial: serialNumber,
    totalCount: matches.length,
    entries: matches
  };
}

// =====================================================
// CASCADE SEARCH
// =====================================================
async function cascadeSearch(serialNumber, complaintType) {
  if (sheetSources.length === 0) {
    return { found: false, message: 'No sheets configured.' };
  }
  
  const typeSheets = sheetSources.filter(s => s.type === complaintType);
  const otherSheets = sheetSources.filter(s => s.type !== complaintType);
  const searchOrder = [...typeSheets, ...otherSheets];
  
  for (const sheet of searchOrder) {
    console.log(`🔍 Searching: ${sheet.name}`);
    const result = await searchInSheet(sheet.id, serialNumber, sheet.gid);
    
    if (result) {
      result.sheetName = sheet.name;
      result.sheetType = sheet.type;
      return { found: true, data: result };
    }
  }
  
  return { found: false, data: null };
}

// =====================================================
// DETECT COMPLAINT TYPE
// =====================================================
function detectComplaintType(text) {
  const lowerText = (text || '').toLowerCase();
  for (const sheet of sheetSources) {
    for (const keyword of sheet.keywords) {
      if (lowerText.includes(keyword)) return sheet.type;
    }
  }
  return 'default';
}

// =====================================================
// ADMIN FUNCTIONS
// =====================================================
function addSheetSource(link, type, name, gid = '0') {
  const match = link.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const id = match ? match[1] : link;
  if (sheetSources.find(s => s.id === id)) return { success: false, message: 'Sheet already exists!' };
  const keywordMap = {
    'ups_offline': ['ups', 'অফলাইন', 'offline', 'power'],
    'ups_online': ['online', 'অনলাইন', 'network'],
    'battery': ['battery', 'ব্যাটারি', 'charge'],
    'sound': ['sound', 'সাউন্ড', 'speaker'],
    'default': ['ups', 'power']
  };
  sheetSources.push({
    id, name: name || type, type, gid,
    keywords: keywordMap[type] || keywordMap['default'],
    addedOn: new Date().toISOString()
  });
  return { success: true, message: `Sheet "${name}" added!` };
}

function removeSheetSource(identifier) {
  const index = sheetSources.findIndex(s => s.name === identifier || s.id === identifier);
  if (index === -1) return { success: false, message: 'Not found!' };
  sheetSources.splice(index, 1);
  return { success: true, message: 'Removed!' };
}

function listSheets() {
  if (sheetSources.length === 0) return '📋 No sheets.';
  let reply = '📋 *Sheets:*\n\n';
  sheetSources.forEach((s, i) => { reply += `${i+1}. ${s.name}\n`; });
  return reply;
}

// =====================================================
// EXPORT
// =====================================================
module.exports = {
  name: 'Sheet Manager',
  version: '2.0.1',
  onReady: async function(client, config) { return initSheetAPI(); },
  searchSheets: async function(serialNumber, text) { return await cascadeSearch(serialNumber, detectComplaintType(text)); },
  addSheet: addSheetSource,
  removeSheet: removeSheetSource,
  listSheets: listSheets,
  parseSheetData,
  detectColumns,
  detectComplaintType,
  downloadSheetCSV  // <-- এই লাইনটি যোগ করুন
};