async generateQuoteDocument(mode) {
        const content = App.getQuoteHTMLString();

        if (mode === 'print') {
            const win = window.open('', '_blank');
            win.document.write(`<html><head><title>Documento</title></head><body style="margin:0">${content}</body></html>`);
            win.document.close();
            setTimeout(() => { win.focus(); win.print(); }, 800);

        } else if (mode === 'pdf') {
            UI.showLoading('Generando PDF...');
            
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = content;
            tempDiv.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background: white; overflow-y: scroll; padding: 40px;`;
            document.body.appendChild(tempDiv);

            // INTENTO DE PROXY SOLO PARA PDF
            const logoImg = tempDiv.querySelector('#pdf-logo-img');
            
            if (logoImg) {
                const googleId = logoImg.getAttribute('data-google-id');
                // Si tenemos ID, intentamos cambiar al proxy
                if (googleId) {
                    console.log("PDF: Intentando cargar desde Proxy:", googleId);
                    logoImg.src = `/.netlify/functions/proxy-image?id=${googleId}`;
                }
            }

            // Esperar carga (sea proxy o directa)
            await new Promise((resolve) => {
                if (!logoImg || !logoImg.src) return resolve();
                
                logoImg.onload = () => resolve();
                logoImg.onerror = () => {
                    console.warn("Imagen PDF falló carga (Proxy o URL). Generando igual.");
                    resolve();
                };
                setTimeout(resolve, 4000); // 4 seg para dar tiempo al proxy
            });

            const opt = {
                margin: 10, 
                filename: `Documento.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { 
                    scale: 2, 
                    useCORS: true, 
                    letterRendering: true,
                    scrollY: 0,
                    windowWidth: 800 
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            try {
                await html2pdf().set(opt).from(tempDiv).save();
                UI.showToast('PDF Descargado');
            } catch (e) {
                console.error(e);
                UI.showToast('Error generando PDF', 'error');
            } finally {
                document.body.removeChild(tempDiv);
                UI.hideLoading();
            }
        }
    },
