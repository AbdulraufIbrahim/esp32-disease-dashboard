import fs from 'fs';

async function test() {
  try {
    const formData = new FormData();
    // we need to pass a file, but let's test if we can just fetch the URL and pass the blob
    const url = "https://www.w3schools.com/w3images/lights.jpg";
    const resp = await fetch(url);
    const blob = await resp.blob();
    formData.append('file', blob, 'lights.jpg');

    const hfResp = await fetch("https://AbdulraufIbrahim-plant-disease-api.hf.space/predict", {
      method: 'POST',
      body: formData
    });
    
    console.log("HF Status:", hfResp.status);
    console.log("HF Response:", await hfResp.text());
  } catch (e) {
    console.error(e);
  }
}

test();
