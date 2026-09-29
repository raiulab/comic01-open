import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  // 漫画生成・Inpaint は Gemini API で 2〜10 分かかることがあるため 15 分に設定
  timeout: 900000
});

export default api;
