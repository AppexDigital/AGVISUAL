// functions/get-website-data.js
// v13.0 - ESTRATEGIA BARRIDO MASIVO (Web Pública)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  const drive = google.drive({ version: 'v3', auth });
  return { doc, drive };
}

function rowsToObjects(sheet, rows) {
  if (!rows || rows.length === 0) return [];
  const headers = sheet.headerValues || [];
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      obj[header] = row.get(header) !== undefined && row.get(header) !== null ? row.get(header) : '';
    });
    return obj;
  });
}

exports.handler = async (event, context) => {
  const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
  };

  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { doc, drive } = await getServices();
    
    const sheetTitles = [
        'Settings', 'About', 'Videos', 'ClientLogos', 
        'Projects', 'ProjectImages', 
        'Services', 'ServiceContentBlocks', 'ServiceImages', 
        'RentalCategories', 'RentalItems', 'RentalItemImages'
    ];

    const sheetPromises = sheetTitles.map(async (title) => {
      const sheet = doc.sheetsByTitle[title];
      if (!sheet) return { title, data: [] };
      await sheet.loadHeaderRow();
      const rows = await sheet.getRows();
      return { title, data: rowsToObjects(sheet, rows) };
    });

    const results = await Promise.all(sheetPromises);
    const sheetsData = {};
    results.forEach(res => sheetsData[res.title] = res.data);

    // --- HIDRATACIÓN MASIVA ---
    try {
        const freshLinksMap = new Map();
        let pageToken = null;

        do {
            const driveRes = await drive.files.list({
                q: "mimeType contains 'image/' and trashed = false",
                fields: 'nextPageToken, files(id, thumbnailLink)',
                pageSize: 1000,
                pageToken: pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true
            });

            if (driveRes.data.files) {
                driveRes.data.files.forEach(f => {
                    if (f.thumbnailLink) {
                        const cleanLink = f.thumbnailLink.split('=')[0];
                        freshLinksMap.set(f.id, `${cleanLink}=s1600`);
                    }
                });
            }
            pageToken = driveRes.data.nextPageToken;
        } while (pageToken);

        const refreshImages = (list) => {
            if (!list) return [];
            return list.map(item => {
                const cleanId = item.fileId ? item.fileId.trim() : null;
                if (cleanId && freshLinksMap.has(cleanId)) {
                    item.imageUrl = freshLinksMap.get(cleanId);
                }
                if (item.logoUrl && cleanId && freshLinksMap.has(cleanId)) {
                     item.logoUrl = freshLinksMap.get(cleanId);
                }
                return item;
            });
        };

        sheetsData.ProjectImages = refreshImages(sheetsData.ProjectImages);
        sheetsData.ServiceImages = refreshImages(sheetsData.ServiceImages);
        sheetsData.RentalItemImages = refreshImages(sheetsData.RentalItemImages);
        sheetsData.ClientLogos = refreshImages(sheetsData.ClientLogos);

    } catch (e) {
        console.warn("Drive refresh failed:", e.message);
    }

    // --- PROCESAMIENTO FINAL ---
    const portfolioImages = (sheetsData.ProjectImages || [])
      .filter(img => img.showInPortfolio && img.showInPortfolio.toLowerCase() === 'si')
      .sort((a, b) => (parseInt(a.portfolioOrder) || 99) - (parseInt(b.portfolioOrder) || 99));

    const settings = (sheetsData.Settings || []).reduce((acc, s) => { if (s.key) acc[s.key] = s.value; return acc; }, {});
    const aboutContent = (sheetsData.About || []).reduce((acc, i) => { if (i.section) acc[i.section] = i.content; return acc; }, {});

    const servicesWithContent = (sheetsData.Services || []).map(service => ({
        ...service,
        contentBlocks: (sheetsData.ServiceContentBlocks || []).filter(b => b.serviceId === service.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
        images: (sheetsData.ServiceImages || []).filter(i => i.serviceId === service.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));

    const rentalItemsWithImages = (sheetsData.RentalItems || []).map(item => ({
        ...item,
        images: (sheetsData.RentalItemImages || []).filter(i => i.itemId === item.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));
    
    const projectsWithImages = (sheetsData.Projects || []).map(project => {
        const pImages = (sheetsData.ProjectImages || []).filter(i => i.projectId === project.id).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));
        const cover = pImages.find(i => i.isCover && i.isCover.toLowerCase() === 'si');
        return { ...project, coverImageUrl: project.coverImageUrl || cover?.imageUrl || pImages[0]?.imageUrl || '', images: pImages };
    }).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0));

    const websiteData = {
      settings, about: aboutContent, portfolioGallery: portfolioImages,
      videos: (sheetsData.Videos || []).sort((a, b) => (parseInt(a.order)||0)-(parseInt(b.order)||0)),
      clientLogos: (sheetsData.ClientLogos || []).sort((a, b) => (parseInt(a.order)||0)-(parseInt(b.order)||0)),
      projects: projectsWithImages, services: servicesWithContent,
      rentalCategories: (sheetsData.RentalCategories || []).sort((a, b) => (parseInt(a.order)||99)-(parseInt(b.order)||0)),
      rentalItems: rentalItemsWithImages,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(websiteData),
    };

  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
