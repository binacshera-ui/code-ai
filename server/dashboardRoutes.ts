import { Router, Request, Response } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const BAKAR_WEBHOOK_URL = process.env.BAKAR_WEBHOOK_URL || 'http://localhost:3001/webhook';
const GEMINI_SERVICE_URL = process.env.GEMINI_SERVICE_URL || 'http://localhost:3002';

interface DemoUser {
  email: string;
  name: string;
  password: string;
  isPerUse: boolean;
  dailyBins: number;
  monthlyBins: number;
}

const demoUsers: Map<string, DemoUser> = new Map([
  ['demo@example.com', {
    email: 'demo@example.com',
    name: 'משתמש דמו',
    password: 'demo123',
    isPerUse: false,
    dailyBins: 50,
    monthlyBins: 100,
  }],
]);

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    console.log('[Dashboard] Login attempt:', email);

    const user = demoUsers.get(email);
    if (user && user.password === password) {
      const { password: _, ...userWithoutPassword } = user;
      return res.json({ 
        success: true, 
        user: userWithoutPassword,
        message: 'התחברת בהצלחה'
      });
    }

    if (email && password) {
      const newUser: DemoUser = {
        email,
        name: email.split('@')[0],
        password,
        isPerUse: false,
        dailyBins: 30,
        monthlyBins: 50,
      };
      demoUsers.set(email, newUser);
      const { password: _, ...userWithoutPassword } = newUser;
      return res.json({ 
        success: true, 
        user: userWithoutPassword,
        message: 'משתמש חדש נוצר והתחבר'
      });
    }

    res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
  } catch (error: any) {
    console.error('[Dashboard] Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;
    
    console.log('[Dashboard] Register attempt:', email);

    if (demoUsers.has(email)) {
      return res.status(400).json({ error: 'משתמש כבר קיים' });
    }

    const newUser: DemoUser = {
      email,
      name: name || email.split('@')[0],
      password,
      isPerUse: false,
      dailyBins: 30,
      monthlyBins: 50,
    };
    demoUsers.set(email, newUser);

    const { password: _, ...userWithoutPassword } = newUser;
    res.json({ 
      success: true, 
      user: userWithoutPassword,
      message: 'נרשמת בהצלחה!'
    });
  } catch (error: any) {
    console.error('[Dashboard] Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/chat', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    
    console.log('[Dashboard] Chat request:', {
      threadId: payload.thread?.id,
      from: payload.message?.from?.address,
      toolChoice: payload.ai_analysis?.tool_choice,
    });

    const response = await forwardToBakar(payload);
    
    res.json({
      success: true,
      response: response?.response || 'הבקשה התקבלה ותטופל בקרוב',
      threadId: payload.thread?.id,
      ...response,
    });
  } catch (error: any) {
    console.error('[Dashboard] Chat error:', error);
    res.json({
      success: true,
      response: `זוהי תשובה מדומה למטרות בדיקה. הבקשה שלך: "${req.body.message?.text || ''}".\n\n[הערכת מערכת: בסביבת בדיקות, Bakar webhook לא זמין]`,
      simulated: true,
    });
  }
});

router.post('/transcription', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const { option, email } = req.body;
    
    console.log('[Dashboard] Transcription request:', {
      fileName: file?.originalname,
      size: file?.size,
      option,
      email,
    });

    res.json({
      success: true,
      message: 'הקובץ נקלט והתמלול יתחיל בקרוב',
      jobId: `job-${Date.now()}`,
      estimatedDuration: file ? Math.round(file.size / 10000) : 60,
      result: `[תמלול מדומה]\n\nשם הקובץ: ${file?.originalname}\nאפשרות: ${option}\n\nזהו תמלול מדומה למטרות בדיקה. בסביבת ייצור, הקובץ יועלה ל-Google Drive ויעובד על ידי שירות התמלול.`,
    });
  } catch (error: any) {
    console.error('[Dashboard] Transcription error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/typing', upload.array('files'), async (req: Request, res: Response) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    const { option, email } = req.body;

    console.log('[Dashboard] Typing request:', {
      files: files.map(file => file.originalname),
      option,
      email,
    });

    res.json({
      success: true,
      message: 'עבודת ההקלדה נרשמה ותועבר לשרשרת כתב היד',
      jobId: `typing-${Date.now()}`,
      filesCount: files.length,
      result: `נקלטו ${files.length} קבצים למסלול ${option}. במערכת המלאה העבודה תישלח לכתובת ההקלדה שתוגדר אצלך ותירשם בשרשרת ההקלדה.`,
    });
  } catch (error: any) {
    console.error('[Dashboard] Typing error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/images', upload.single('image'), async (req: Request, res: Response) => {
  try {
    const image = req.file;
    const { prompt, option, email } = req.body;
    
    console.log('[Dashboard] Image request:', {
      hasImage: !!image,
      prompt: prompt?.slice(0, 50),
      option,
      email,
    });

    res.json({
      success: true,
      message: 'התמונה נוצרה בהצלחה',
      url: `https://placehold.co/512x512/6366f1/white?text=${encodeURIComponent(prompt?.slice(0, 20) || 'תמונה')}`,
      prompt,
      option,
    });
  } catch (error: any) {
    console.error('[Dashboard] Image error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/edit', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const { input, option, email } = req.body;
    
    console.log('[Dashboard] Edit request:', {
      hasFile: !!file,
      inputLength: input?.length,
      option,
      email,
    });

    let result = '';
    
    switch (option) {
      case 'torah_search_fast':
        result = `[חיפוש מקורות]\n\nלפי בקשתך: "${input?.slice(0, 100)}"\n\nמצאתי את המקורות הבאים:\n- שולחן ערוך, אורח חיים, סימן א\n- רמב"ם, הלכות תפילה, פרק א\n- גמרא ברכות, דף ל ע"א\n\n[מדומה למטרות בדיקה]`;
        break;
      case 'torah_article':
        result = `[מאמר תורני]\n\nנושא: ${input?.slice(0, 50)}\n\nפתיחה:\n...\n\nעיקר הדברים:\n...\n\nסיכום:\n...\n\n[מדומה למטרות בדיקה]`;
        break;
      case 'translate':
        result = `[תרגום]\n\nטקסט מקורי: ${input?.slice(0, 100)}\n\nתרגום:\n...\n\n[מדומה למטרות בדיקה]`;
        break;
      default:
        result = `[עריכה - ${option}]\n\nהקלט שלך: ${input?.slice(0, 200)}\n\nתוצאה מעובדת:\n...\n\n[מדומה למטרות בדיקה]`;
    }

    res.json({
      success: true,
      result,
      option,
    });
  } catch (error: any) {
    console.error('[Dashboard] Edit error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/code', async (req: Request, res: Response) => {
  try {
    const { input, code, option, email } = req.body;
    
    console.log('[Dashboard] Code request:', {
      inputLength: input?.length,
      hasCode: !!code,
      option,
      email,
    });

    let result = '';
    
    switch (option) {
      case 'super_agent':
        result = `[סוכן קוד]\n\n$ Analyzing request...\n$ Connecting to repository...\n$ Executing task: ${input?.slice(0, 50)}\n\n✓ Task completed successfully\n\n[מדומה למטרות בדיקה - בסביבת ייצור יתחבר לסוכן הקוד המלא]`;
        break;
      case 'code_writer':
        result = `// Generated code for: ${input?.slice(0, 50)}\n\nfunction solution() {\n  // Implementation here\n  return result;\n}\n\n// [מדומה למטרות בדיקה]`;
        break;
      case 'code_editor':
        result = `// Edited code:\n\n${code ? code.slice(0, 200) + '\n// ... (edited)' : '// No code provided'}\n\n// [מדומה למטרות בדיקה]`;
        break;
      case 'code_explainer':
        result = `[הסבר קוד]\n\nהקוד שסיפקת:\n${code?.slice(0, 100) || input?.slice(0, 100)}\n\nהסבר:\nזהו קוד ש...\n\n[מדומה למטרות בדיקה]`;
        break;
      default:
        result = `[קוד - ${option}]\n\n${input}\n\n[מדומה למטרות בדיקה]`;
    }

    res.json({
      success: true,
      result,
      option,
    });
  } catch (error: any) {
    console.error('[Dashboard] Code error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/history', async (req: Request, res: Response) => {
  try {
    const { email } = req.query;
    
    console.log('[Dashboard] History request:', { email });

    res.json({
      success: true,
      entries: [],
      message: 'היסטוריה נטענת מהשרת',
    });
  } catch (error: any) {
    console.error('[Dashboard] History error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings', async (req: Request, res: Response) => {
  try {
    const settings = req.body;
    
    console.log('[Dashboard] Settings update:', {
      userEmail: settings.userEmail,
      name: settings.name,
    });

    res.json({
      success: true,
      message: 'ההגדרות נשמרו בהצלחה',
    });
  } catch (error: any) {
    console.error('[Dashboard] Settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function forwardToBakar(payload: any): Promise<any> {
  try {
    const response = await fetch(BAKAR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`Bakar returned ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('[Dashboard] Bakar forward failed:', error);
    throw error;
  }
}

export default router;
