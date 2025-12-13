// functions/get-website-data.js
// v13.0 - ESTRATEGIA BARRIDO MASIVO (Web Pública)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

exports.handler = async (event, context) => {
  const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    const sheetTitles = ['Settings', 'About', 'Videos', 'ClientLogos', 'Projects', 'ProjectImages', 'Services', 'ServiceContentBlocks', 'ServiceImages', 'RentalCategories', 'RentalItems', 'RentalItemImages'];
    const sheetsData = {};

    const promises = sheetTitles.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (sheet) {
                await sheet.loadHeaderRow();
                const rows = await sheet.getRows();
                const hVals = sheet.headerValues;
                sheetsData[title] = rows.map(row => {
                    const obj = {};
                    hVals.forEach(h => obj[h] = row.get(h) || '');
                    return obj;
                });
            } else { sheetsData[title] = []; }
        } catch(e) { sheetsData[title] = []; }
    });

    await Promise.all(promises);

    // Procesamiento Estándar (Sin Hidratación)
    const portfolioImages = (sheetsData.ProjectImages||[]).filter(i => String(i.showInPortfolio).toLowerCase() === 'si').sort((a,b)=>(parseInt(a.portfolioOrder)||99)-(parseInt(b.portfolioOrder)||99));
    const settings = (sheetsData.Settings||[]).reduce((acc, s) => { if (s.key) acc[s.key] = s.value; return acc; }, {});
    const aboutContent = (sheetsData.About||[]).reduce((acc, i) => { if (i.section) acc[i.section] = i.content; return acc; }, {});

    const servicesWithContent = (sheetsData.Services||[]).map(service => ({
        ...service,
        contentBlocks: (sheetsData.ServiceContentBlocks||[]).filter(b => b.serviceId === service.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
        images: (sheetsData.ServiceImages||[]).filter(i => i.serviceId === service.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));

    const rentalItemsWithImages = (sheetsData.RentalItems||[]).map(item => ({
        ...item,
        images: (sheetsData.RentalItemImages||[]).filter(i => i.itemId === item.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
    })).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
    
    const projectsWithImages = (sheetsData.Projects||[]).map(project => {
        const pImages = (sheetsData.ProjectImages||[]).filter(i => i.projectId === project.id).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));
        const cover = pImages.find(i => String(i.isCover).toLowerCase() === 'si');
        return { ...project, coverImageUrl: project.coverImageUrl || cover?.imageUrl || pImages[0]?.imageUrl || '', images: pImages };
    }).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0));

    const websiteData = {
      settings, about: aboutContent, portfolioGallery: portfolioImages,
      videos: (sheetsData.Videos||[]).sort((a,b)=>(parseInt(a.order)||0)-(parseInt(b.order)||0)),
      clientLogos: (sheetsData.ClientLogos||[]).sort((a,b)=>(parseInt(a.order)||0)-(parseInt(b.order)||0)),
      projects: projectsWithImages, services: servicesWithContent,
      rentalCategories: (sheetsData.RentalCategories||[]).sort((a,b)=>(parseInt(a.order)||99)-(parseInt(b.order)||0)),
      rentalItems: rentalItemsWithImages,
    };

    return { statusCode: 200, headers, body: JSON.stringify(websiteData) };

  } catch (error) { return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) }; }
};
