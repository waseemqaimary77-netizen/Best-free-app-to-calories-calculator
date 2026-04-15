/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, ChangeEvent, Component, ErrorInfo, ReactNode } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Camera, Loader2, Utensils, Info, History, Trash2, AlertCircle, 
  Plus, Calendar, MessageSquare, Droplets, Settings, User, 
  ChevronLeft, ChevronRight, Play, CheckCircle2, Send, X, Edit2,
  LogIn, LogOut
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  auth, db, googleProvider, signInWithPopup, onAuthStateChanged, signOut,
  doc, setDoc, getDoc, collection, addDoc, query, orderBy, onSnapshot, deleteDoc,
  handleFirestoreError, OperationType
} from './firebase';

// --- Error Boundary ---
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50 text-center" dir="rtl">
          <div className="max-w-md w-full bg-white p-8 rounded-3xl shadow-xl border border-red-100">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">عذراً، حدث خطأ غير متوقع</h1>
            <p className="text-gray-500 mb-6">يرجى إعادة تحميل الصفحة والمحاولة مرة أخرى.</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition-colors"
            >
              إعادة تحميل التطبيق
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- Types ---
interface FoodItem {
  name: string;
  weight: number;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  caloriesPer100g: number;
}

interface NutritionInfo {
  items: FoodItem[];
  totalCalories: number;
  description: string;
}

interface ScanHistory {
  id: string;
  image?: string;
  nutrition: NutritionInfo;
  timestamp: number;
  category: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  notes?: string;
}

interface UserProfile {
  height: number;
  weight: number;
  age: number;
  gender: 'male' | 'female';
  activityLevel: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  calorieGoal: number;
  waterGoal: number;
}

interface Workout {
  id: string;
  name: string;
  exercises: { name: string; sets: string; reps: string; videoUrl?: string }[];
}

interface MealEntry {
  id: string;
  name: string;
  calories: number;
  type: 'breakfast' | 'lunch' | 'dinner' | 'snack';
}

interface DaySchedule {
  meals: MealEntry[];
  workouts: Workout[];
}

interface WeeklySchedule {
  [key: string]: DaySchedule; // 'Saturday', 'Sunday', etc.
}

interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

// --- Constants ---
const MODEL_NAME = "gemini-3-flash-preview";
const DAYS = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
const DAY_KEYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function CalorieSnapApp() {
  // Auth State
  const [user, setUser] = useState<any>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Navigation
  const [activeTab, setActiveTab] = useState<'dashboard' | 'schedule' | 'chat' | 'settings'>('dashboard');

  // User Data
  const [profile, setProfile] = useState<UserProfile>({
    height: 170,
    weight: 70,
    age: 25,
    gender: 'male',
    activityLevel: 'moderate',
    calorieGoal: 2000,
    waterGoal: 2.5
  });

  // Tracking Data
  const [history, setHistory] = useState<ScanHistory[]>([]);
  const [waterIntake, setWaterIntake] = useState(0);
  const [schedule, setSchedule] = useState<WeeklySchedule>(() => {
    const initial: WeeklySchedule = {};
    DAY_KEYS.forEach(day => {
      initial[day] = { meals: [], workouts: [] };
    });
    return initial;
  });

  // UI States
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMealModal, setShowMealModal] = useState(false);
  const [manualMeal, setManualMeal] = useState({ name: '', calories: '', weight: '', category: 'breakfast' as any, notes: '' });
  const [calculatingManual, setCalculatingManual] = useState(false);
  const [scanResult, setScanResult] = useState<NutritionInfo | null>(null);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showPrepModal, setShowPrepModal] = useState(false);
  const [pendingImageData, setPendingImageData] = useState<string | null>(null);
  const [mealCategory, setMealCategory] = useState<'breakfast' | 'lunch' | 'dinner' | 'snack'>('breakfast');
  const [mealNotes, setMealNotes] = useState('');
  
  // Chat States
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'model', content: 'مرحباً! أنا مدربك الذكي. كيف يمكنني مساعدتك اليوم؟ يمكنني اقتراح وجبات، وضع جداول غذائية أو تدريبية، وتعديلها لك.' }
  ]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Firestore Sync - Profile
  useEffect(() => {
    if (!user || !isAuthReady) return;
    const userDoc = doc(db, 'users', user.uid);
    
    // Initial fetch
    getDoc(userDoc).then(docSnap => {
      if (docSnap.exists()) {
        setProfile(docSnap.data() as UserProfile);
      } else {
        // Create initial profile if doesn't exist
        setDoc(userDoc, profile);
      }
    }).catch(err => handleFirestoreError(err, OperationType.GET, `users/${user.uid}`));

    // Sync Water
    const waterDoc = doc(db, 'users', user.uid, 'stats', 'water');
    getDoc(waterDoc).then(docSnap => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const lastUpdated = new Date(data.lastUpdated);
        if (lastUpdated.toDateString() === new Date().toDateString()) {
          setWaterIntake(data.intake);
        } else {
          setWaterIntake(0);
        }
      }
    });

    // Sync Schedule
    const scheduleDoc = doc(db, 'users', user.uid, 'schedule', 'weekly');
    getDoc(scheduleDoc).then(docSnap => {
      if (docSnap.exists()) {
        setSchedule(docSnap.data() as WeeklySchedule);
      }
    });

    // Real-time History
    const historyCol = collection(db, 'users', user.uid, 'history');
    const q = query(historyCol, orderBy('timestamp', 'desc'));
    const unsubscribeHistory = onSnapshot(q, (snapshot) => {
      const items: ScanHistory[] = [];
      snapshot.forEach(doc => {
        items.push({ id: doc.id, ...doc.data() } as ScanHistory);
      });
      setHistory(items);
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/history`));

    return () => unsubscribeHistory();
  }, [user, isAuthReady]);

  // Update Profile in Firestore
  const updateProfile = async (newProfile: UserProfile) => {
    setProfile(newProfile);
    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid), newProfile);
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}`);
      }
    }
  };

  // Update Water in Firestore
  const updateWater = async (newIntake: number) => {
    setWaterIntake(newIntake);
    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid, 'stats', 'water'), {
          intake: newIntake,
          lastUpdated: Date.now()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/stats/water`);
      }
    }
  };

  // Update Schedule in Firestore
  const updateSchedule = async (newSchedule: WeeklySchedule) => {
    setSchedule(newSchedule);
    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid, 'schedule', 'weekly'), newSchedule);
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}/schedule/weekly`);
      }
    }
  };

  // Auth Handlers
  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed", err);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      // Reset local state
      setHistory([]);
      setWaterIntake(0);
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  // Calorie Calculation
  const calculateBMR = () => {
    const { weight, height, age, gender } = profile;
    if (gender === 'male') {
      return 10 * weight + 6.25 * height - 5 * age + 5;
    } else {
      return 10 * weight + 6.25 * height - 5 * age - 161;
    }
  };

  const calculateTDEE = () => {
    const bmr = calculateBMR();
    const multipliers = {
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9
    };
    return Math.round(bmr * multipliers[profile.activityLevel]);
  };

  const updateGoalFromProfile = () => {
    const tdee = calculateTDEE();
    updateProfile({ ...profile, calorieGoal: tdee });
  };

  // Handlers
  const handleImageUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPendingImageData(reader.result as string);
        setShowPrepModal(true);
        setError(null);
      };
      reader.onerror = () => setError("فشل في قراءة ملف الصورة.");
      reader.readAsDataURL(file);
    }
  };

  const analyzeImage = async (imgData: string, category: string, notes: string) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return setError("مفتاح API غير متوفر.");

    setLoading(true);
    try {
      const ai = new GoogleGenAI({ apiKey });
      const base64Data = imgData.split(',')[1];
      const mimeType = imgData.split(';')[0].split(':')[1];

      const prompt = `Analyze this food image. Identify all food items present. 
      User notes about preparation: "${notes}". 
      Meal category: "${category}".
      For each item, estimate its weight in grams and provide average nutritional values (not minimum). 
      Provide the response in JSON format.`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: {
          parts: [
            { inlineData: { data: base64Data, mimeType } },
            { text: prompt }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    weight: { type: Type.NUMBER, description: "Estimated weight in grams" },
                    calories: { type: Type.NUMBER },
                    protein: { type: Type.NUMBER },
                    carbs: { type: Type.NUMBER },
                    fats: { type: Type.NUMBER },
                    caloriesPer100g: { type: Type.NUMBER }
                  },
                  required: ["name", "weight", "calories", "protein", "carbs", "fats", "caloriesPer100g"]
                }
              },
              totalCalories: { type: Type.NUMBER },
              description: { type: Type.STRING }
            },
            required: ["items", "totalCalories", "description"]
          }
        }
      });

      const data = JSON.parse(response.text || '{}') as NutritionInfo;
      setScanResult(data);
      setShowScanModal(true);
      setImage(null);
    } catch (err) {
      setError("فشل تحليل الصورة.");
    } finally {
      setLoading(false);
    }
  };

  const calculateManualCalories = async () => {
    if (!manualMeal.name || !manualMeal.weight) return;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return;

    setCalculatingManual(true);
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `Estimate average calories and macros for ${manualMeal.weight}g of ${manualMeal.name}. Return JSON: { calories: number, protein: number, carbs: number, fats: number }`,
        config: { responseMimeType: "application/json" }
      });
      const data = JSON.parse(response.text || '{}');
      setManualMeal(prev => ({ ...prev, calories: data.calories.toString() }));
    } catch (e) {
      console.error(e);
    } finally {
      setCalculatingManual(false);
    }
  };

  const confirmScanResult = async () => {
    if (!scanResult) return;
    
    const newEntry = {
      nutrition: scanResult,
      timestamp: Date.now(),
      category: mealCategory,
      notes: mealNotes
    };

    if (user) {
      try {
        await addDoc(collection(db, 'users', user.uid, 'history'), newEntry);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/history`);
      }
    } else {
      setHistory(prev => [{ id: Date.now().toString(), ...newEntry }, ...prev] as any);
    }
    
    setShowScanModal(false);
    setScanResult(null);
    setMealNotes('');
  };

  const updateScanItemWeight = (index: number, newWeight: number) => {
    if (!scanResult) return;
    const updatedItems = [...scanResult.items];
    const item = updatedItems[index];
    const ratio = item.weight > 0 ? newWeight / item.weight : 0;
    
    updatedItems[index] = {
      ...item,
      weight: newWeight,
      calories: Math.round((item.calories || 0) * ratio),
      protein: Number(((item.protein || 0) * ratio).toFixed(1)),
      carbs: Number(((item.carbs || 0) * ratio).toFixed(1)),
      fats: Number(((item.fats || 0) * ratio).toFixed(1)),
    };

    setScanResult({
      ...scanResult,
      items: updatedItems,
      totalCalories: updatedItems.reduce((sum, i) => sum + (i.calories || 0), 0)
    });
  };

  const addManualMeal = async () => {
    if (!manualMeal.name || !manualMeal.calories) return;
    
    const newEntry = {
      nutrition: {
        items: [{
          name: manualMeal.name,
          weight: parseInt(manualMeal.weight) || 100,
          calories: parseInt(manualMeal.calories),
          protein: 0,
          carbs: 0,
          fats: 0,
          caloriesPer100g: 0
        }],
        totalCalories: parseInt(manualMeal.calories),
        description: 'إضافة يدوية'
      },
      timestamp: Date.now(),
      category: manualMeal.category,
      notes: manualMeal.notes
    };

    if (user) {
      try {
        await addDoc(collection(db, 'users', user.uid, 'history'), newEntry);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/history`);
      }
    } else {
      setHistory(prev => [{ id: Date.now().toString(), ...newEntry }, ...prev] as any);
    }

    setShowMealModal(false);
    setManualMeal({ name: '', calories: '', weight: '', category: 'breakfast', notes: '' });
  };

  const deleteHistoryItem = async (id: string) => {
    if (user) {
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'history', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/history/${id}`);
      }
    } else {
      setHistory(prev => prev.filter(item => item.id !== id));
    }
  };

  const totalCaloriesToday = history
    .filter(item => new Date(item.timestamp).toDateString() === new Date().toDateString())
    .reduce((sum, item) => sum + (item.nutrition.totalCalories || 0), 0);

  // AI Chat Logic
  const sendMessage = async () => {
    if (!input.trim() || chatLoading) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatLoading(true);

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("API Key missing");

      const ai = new GoogleGenAI({ apiKey });
      
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: messages.concat({ role: 'user', content: userMsg }).map(m => ({
          role: m.role,
          parts: [{ text: m.content }]
        })),
        config: {
          systemInstruction: `أنت مدرب لياقة وتغذية ذكي. يمكنك مساعدة المستخدم في:
1. اقتراح وجبات صحية.
2. وضع جداول غذائية وتدريبية أسبوعية.
3. تعديل الجداول الحالية.

عندما يطلب المستخدم وضع جدول أو تعديله، يجب أن ترد بصيغة JSON بالإضافة إلى النص العادي.
تنسيق الـ JSON المطلوب للتعديلات:
{
  "action": "update_schedule",
  "schedule": {
    "Monday": { "meals": [{ "name": "...", "calories": 500, "type": "breakfast" }], "workouts": [{ "name": "...", "exercises": [{ "name": "...", "sets": "3", "reps": "12", "videoUrl": "..." }] }] }
  }
}
يمكنك تحديث أي يوم من أيام الأسبوع: Saturday, Sunday, Monday, Tuesday, Wednesday, Thursday, Friday.
هام جداً: بالنسبة لروابط الفيديوهات، استخدم دائماً روابط بحث يوتيوب لضمان عملها، مثل: https://www.youtube.com/results?search_query=pushups+exercise
تحدث باللغة العربية بلهجة ودودة ومشجعة.`
        }
      });

      const text = response.text;
      if (!text) throw new Error("No response text");
      
      // Try to extract JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          if (data.action === 'update_schedule') {
            setSchedule(prev => ({ ...prev, ...data.schedule }));
          }
        } catch (e) {
          console.error("Failed to parse AI JSON", e);
        }
      }

      setMessages(prev => [...prev, { role: 'model', content: text.replace(/\{[\s\S]*\}/, '').trim() }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'model', content: 'عذراً، حدث خطأ في معالجة طلبك.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Renderers
  const renderDashboard = () => (
    <div className="space-y-6">
      {/* Calorie Progress */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-black/5">
        <div className="flex justify-between items-end mb-4">
          <div>
            <h3 className="text-gray-500 text-sm font-medium">السعرات اليومية</h3>
            <p className="text-3xl font-black text-emerald-600">{totalCaloriesToday} <span className="text-lg font-normal text-gray-400">/ {profile.calorieGoal}</span></p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-gray-400">المتبقي</p>
            <p className="text-xl font-bold">{Math.max(0, profile.calorieGoal - totalCaloriesToday)}</p>
          </div>
        </div>
        <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, (totalCaloriesToday / profile.calorieGoal) * 100)}%` }}
            className="h-full bg-emerald-500"
          />
        </div>
      </section>

      {/* Water Tracker */}
      <section className="bg-blue-50 p-6 rounded-3xl border border-blue-100 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-500 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200">
            <Droplets className="text-white w-6 h-6" />
          </div>
          <div>
            <h3 className="font-bold text-blue-900">متتبع الماء</h3>
            <p className="text-blue-700 text-sm">{waterIntake.toFixed(1)} / {profile.waterGoal} لتر</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setWaterIntake(Math.max(0, waterIntake - 0.25))}
            className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-blue-500 shadow-sm"
          >
            -
          </button>
          <button 
            onClick={() => setWaterIntake(waterIntake + 0.25)}
            className="w-10 h-10 rounded-xl bg-blue-500 flex items-center justify-center text-white shadow-lg shadow-blue-200"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      </section>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-4">
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="bg-emerald-500 text-white p-6 rounded-3xl flex flex-col items-center gap-3 shadow-lg shadow-emerald-100 hover:scale-[1.02] transition-transform"
        >
          <Camera className="w-8 h-8" />
          <span className="font-bold">تصوير وجبة</span>
        </button>
        <button 
          onClick={() => setShowMealModal(true)}
          className="bg-white border border-black/5 p-6 rounded-3xl flex flex-col items-center gap-3 shadow-sm hover:scale-[1.02] transition-transform"
        >
          <Edit2 className="w-8 h-8 text-emerald-500" />
          <span className="font-bold">إضافة يدوية</span>
        </button>
      </div>

      {/* Recent History */}
      <section className="space-y-4">
        <h3 className="font-bold text-lg">الوجبات الأخيرة</h3>
        <div className="space-y-3">
          {history.slice(0, 5).map(item => (
            <div key={item.id} className="bg-white p-4 rounded-2xl border border-black/5 flex items-center gap-4">
              {item.image ? (
                <img src={item.image} className="w-12 h-12 rounded-xl object-cover" alt="" />
              ) : (
                <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center">
                  <Utensils className="text-emerald-500 w-6 h-6" />
                </div>
              )}
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase ${
                    item.category === 'breakfast' ? 'bg-amber-100 text-amber-600' :
                    item.category === 'lunch' ? 'bg-blue-100 text-blue-600' :
                    item.category === 'dinner' ? 'bg-indigo-100 text-indigo-600' :
                    'bg-emerald-100 text-emerald-600'
                  }`}>
                    {item.category === 'breakfast' ? 'فطور' :
                     item.category === 'lunch' ? 'غداء' :
                     item.category === 'dinner' ? 'عشاء' : 'سناك'}
                  </span>
                  <h4 className="font-bold text-sm">
                    {item.nutrition.items.map(i => i.name).join(' + ')}
                  </h4>
                </div>
                {item.notes && <p className="text-[10px] text-gray-500 italic mb-1">"{item.notes}"</p>}
                <p className="text-[10px] text-gray-400">{new Date(item.timestamp).toLocaleTimeString('ar-EG')}</p>
              </div>
              <div className="text-right">
                <p className="font-black text-emerald-600">{item.nutrition.totalCalories}</p>
                <p className="text-[10px] text-gray-400 font-bold">سعرة</p>
              </div>
              <button onClick={() => deleteHistoryItem(item.id)} className="text-gray-300 hover:text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const updateScheduleMeal = (day: string, mIdx: number, field: string, value: string) => {
    const newSchedule = { ...schedule };
    const newMeals = [...newSchedule[day].meals];
    newMeals[mIdx] = { ...newMeals[mIdx], [field]: field === 'calories' ? parseInt(value) || 0 : value };
    newSchedule[day] = { ...newSchedule[day], meals: newMeals };
    updateSchedule(newSchedule);
  };

  const updateScheduleWorkout = (day: string, wIdx: number, field: string, value: string) => {
    const newSchedule = { ...schedule };
    const newWorkouts = [...newSchedule[day].workouts];
    newWorkouts[wIdx] = { ...newWorkouts[wIdx], [field]: value };
    newSchedule[day] = { ...newSchedule[day], workouts: newWorkouts };
    updateSchedule(newSchedule);
  };

  const updateScheduleExercise = (day: string, wIdx: number, eIdx: number, field: string, value: string) => {
    const newSchedule = { ...schedule };
    const newWorkouts = [...newSchedule[day].workouts];
    const newExercises = [...newWorkouts[wIdx].exercises];
    newExercises[eIdx] = { ...newExercises[eIdx], [field]: value };
    newWorkouts[wIdx] = { ...newWorkouts[wIdx], exercises: newExercises };
    newSchedule[day] = { ...newSchedule[day], workouts: newWorkouts };
    updateSchedule(newSchedule);
  };

  const addMealToSchedule = (day: string) => {
    const newSchedule = { ...schedule };
    newSchedule[day].meals.push({ id: Date.now().toString(), name: 'وجبة جديدة', calories: 0, type: 'snack' });
    updateSchedule(newSchedule);
  };

  const addWorkoutToSchedule = (day: string) => {
    const newSchedule = { ...schedule };
    newSchedule[day].workouts.push({ id: Date.now().toString(), name: 'تمرين جديد', exercises: [{ name: 'تمرين', sets: '3', reps: '12' }] });
    updateSchedule(newSchedule);
  };

  const renderSchedule = () => (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black">الجدول الأسبوعي</h2>
        <div className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold">خطة مخصصة</div>
      </div>

      <div className="space-y-4">
        {DAY_KEYS.map((dayKey, idx) => (
          <details key={dayKey} className="group bg-white rounded-3xl border border-black/5 overflow-hidden">
            <summary className="p-6 flex items-center justify-between cursor-pointer list-none">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center font-bold text-gray-500">
                  {idx + 1}
                </div>
                <h3 className="text-lg font-bold">{DAYS[idx]}</h3>
              </div>
              <ChevronLeft className="w-5 h-5 text-gray-400 group-open:rotate-[-90deg] transition-transform" />
            </summary>
            <div className="p-6 pt-0 space-y-6 border-t border-gray-50">
              {/* Meals */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-bold text-gray-400 flex items-center gap-2">
                    <Utensils className="w-4 h-4" /> الوجبات
                  </h4>
                  <button onClick={() => addMealToSchedule(dayKey)} className="text-emerald-500 hover:bg-emerald-50 p-1 rounded-lg">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {schedule[dayKey].meals.length > 0 ? (
                  schedule[dayKey].meals.map((meal, mIdx) => (
                    <div key={mIdx} className="bg-emerald-50 p-3 rounded-xl flex gap-2 items-center">
                      <input 
                        value={meal.name}
                        onChange={e => updateScheduleMeal(dayKey, mIdx, 'name', e.target.value)}
                        className="bg-transparent border-none font-bold text-emerald-900 flex-1 text-sm focus:ring-0"
                      />
                      <div className="flex items-center gap-1">
                        <input 
                          type="number"
                          value={meal.calories || ''}
                          onChange={e => updateScheduleMeal(dayKey, mIdx, 'calories', e.target.value)}
                          className="bg-white/50 border-none w-16 text-center text-xs font-bold text-emerald-600 rounded-lg focus:ring-0"
                        />
                        <span className="text-[10px] text-emerald-600 font-bold">سعرة</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-400 italic">لا توجد وجبات مسجلة</p>
                )}
              </div>

              {/* Workouts */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-bold text-gray-400 flex items-center gap-2">
                    <Plus className="w-4 h-4" /> التمارين
                  </h4>
                  <button onClick={() => addWorkoutToSchedule(dayKey)} className="text-emerald-500 hover:bg-emerald-50 p-1 rounded-lg">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {schedule[dayKey].workouts.length > 0 ? (
                  schedule[dayKey].workouts.map((workout, wIdx) => (
                    <div key={wIdx} className="space-y-3 border-b border-gray-50 pb-4 last:border-0">
                      <input 
                        value={workout.name}
                        onChange={e => updateScheduleWorkout(dayKey, wIdx, 'name', e.target.value)}
                        className="font-bold text-lg bg-transparent border-none w-full focus:ring-0"
                      />
                      <div className="space-y-2">
                        {workout.exercises.map((ex, eIdx) => (
                          <div key={eIdx} className="bg-gray-50 p-4 rounded-2xl flex items-center justify-between gap-4">
                            <div className="flex-1 space-y-1">
                              <input 
                                value={ex.name}
                                onChange={e => updateScheduleExercise(dayKey, wIdx, eIdx, 'name', e.target.value)}
                                className="font-bold bg-transparent border-none w-full text-sm focus:ring-0 p-0"
                              />
                              <div className="flex items-center gap-2">
                                <input 
                                  value={ex.sets}
                                  onChange={e => updateScheduleExercise(dayKey, wIdx, eIdx, 'sets', e.target.value)}
                                  className="w-8 bg-white border border-black/5 rounded text-[10px] text-center p-0.5"
                                />
                                <span className="text-[10px] text-gray-400">جولات ×</span>
                                <input 
                                  value={ex.reps}
                                  onChange={e => updateScheduleExercise(dayKey, wIdx, eIdx, 'reps', e.target.value)}
                                  className="w-8 bg-white border border-black/5 rounded text-[10px] text-center p-0.5"
                                />
                                <span className="text-[10px] text-gray-400">تكرار</span>
                              </div>
                            </div>
                            {ex.videoUrl && (
                              <a href={ex.videoUrl} target="_blank" rel="noreferrer" className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-rose-500 shadow-sm shrink-0">
                                <Play className="w-5 h-5 fill-current" />
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-400 italic">يوم راحة</p>
                )}
              </div>
            </div>
          </details>
        ))}
      </div>
    </div>
  );

  const renderChat = () => (
    <div className="flex flex-col h-[calc(100vh-180px)]">
      <div className="flex-1 overflow-y-auto space-y-4 p-2">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] p-4 rounded-3xl text-sm leading-relaxed ${
              m.role === 'user' 
                ? 'bg-emerald-500 text-white rounded-tr-none' 
                : 'bg-white border border-black/5 rounded-tl-none shadow-sm'
            }`}>
              {m.content}
            </div>
          </div>
        ))}
        {chatLoading && (
          <div className="flex justify-end">
            <div className="bg-white border border-black/5 p-4 rounded-3xl rounded-tl-none shadow-sm">
              <Loader2 className="w-5 h-5 animate-spin text-emerald-500" />
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <input 
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyPress={e => e.key === 'Enter' && sendMessage()}
          placeholder="اسأل المدرب عن وجبة أو جدول..."
          className="flex-1 bg-white border border-black/5 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <button 
          onClick={sendMessage}
          disabled={chatLoading}
          className="bg-emerald-500 text-white p-3 rounded-2xl shadow-lg shadow-emerald-100 disabled:opacity-50"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );

  const renderSettings = () => (
    <div className="space-y-8">
      <div className="text-center">
        <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <User className="text-emerald-600 w-10 h-10" />
        </div>
        <h2 className="text-xl font-bold">الملف الشخصي</h2>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-xs font-bold text-gray-400">الوزن (كجم)</label>
          <input 
            type="number" 
            value={profile.weight || ''}
            onChange={e => updateProfile({...profile, weight: parseInt(e.target.value) || 0})}
            className="w-full bg-white border border-black/5 p-3 rounded-xl font-bold"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-bold text-gray-400">الطول (سم)</label>
          <input 
            type="number" 
            value={profile.height || ''}
            onChange={e => updateProfile({...profile, height: parseInt(e.target.value) || 0})}
            className="w-full bg-white border border-black/5 p-3 rounded-xl font-bold"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-bold text-gray-400">العمر</label>
          <input 
            type="number" 
            value={profile.age || ''}
            onChange={e => updateProfile({...profile, age: parseInt(e.target.value) || 0})}
            className="w-full bg-white border border-black/5 p-3 rounded-xl font-bold"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-bold text-gray-400">الجنس</label>
          <select 
            value={profile.gender}
            onChange={e => updateProfile({...profile, gender: e.target.value as any})}
            className="w-full bg-white border border-black/5 p-3 rounded-xl font-bold"
          >
            <option value="male">ذكر</option>
            <option value="female">أنثى</option>
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-bold text-gray-400">مستوى النشاط</label>
        <select 
          value={profile.activityLevel}
          onChange={e => updateProfile({...profile, activityLevel: e.target.value as any})}
          className="w-full bg-white border border-black/5 p-3 rounded-xl font-bold"
        >
          <option value="sedentary">خامل</option>
          <option value="light">نشاط خفيف</option>
          <option value="moderate">نشاط متوسط</option>
          <option value="active">نشط جداً</option>
          <option value="very_active">رياضي محترف</option>
        </select>
      </div>

      <div className="space-y-4">
        <button 
          onClick={updateGoalFromProfile}
          className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-bold shadow-xl shadow-emerald-100"
        >
          تحديث الهدف تلقائياً
        </button>
        <div className="space-y-2">
          <label className="text-xs font-bold text-gray-400">هدف السعرات اليدوي</label>
          <input 
            type="number" 
            value={profile.calorieGoal || ''}
            onChange={e => updateProfile({...profile, calorieGoal: parseInt(e.target.value) || 0})}
            className="w-full bg-white border border-black/5 p-3 rounded-xl font-bold text-center text-2xl text-emerald-600"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 pt-4 border-t border-gray-100 mt-6">
        {user ? (
          <button 
            onClick={logout}
            className="w-full py-4 bg-gray-50 text-gray-600 rounded-2xl font-bold flex items-center justify-center gap-2"
          >
            <LogOut className="w-5 h-5" /> تسجيل الخروج
          </button>
        ) : (
          <button 
            onClick={login}
            className="w-full py-4 bg-emerald-50 text-emerald-600 rounded-2xl font-bold flex items-center justify-center gap-2"
          >
            <LogIn className="w-5 h-5" /> تسجيل الدخول بحساب جوجل
          </button>
        )}
        <button 
          onClick={() => {
            if(window.confirm('هل أنت متأكد من مسح السجل؟')) {
              setHistory([]);
              localStorage.removeItem('cs_history');
            }
          }}
          className="w-full py-4 bg-red-50 text-red-600 rounded-2xl font-bold flex items-center justify-center gap-2"
        >
          <Trash2 className="w-5 h-5" /> مسح سجل الوجبات
        </button>
        <button 
          onClick={() => {
            if(window.confirm('هل أنت متأكد من مسح الجدول الأسبوعي؟')) {
              const initial: WeeklySchedule = {};
              DAY_KEYS.forEach(day => {
                initial[day] = { meals: [], workouts: [] };
              });
              setSchedule(initial);
              localStorage.removeItem('cs_schedule');
            }
          }}
          className="w-full py-4 bg-gray-50 text-gray-600 rounded-2xl font-bold flex items-center justify-center gap-2"
        >
          <Calendar className="w-5 h-5" /> إعادة تعيين الجدول الأسبوعي
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans selection:bg-emerald-100 pb-24" dir="rtl">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-black/5 px-6 py-4">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-200">
              <Utensils className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight leading-none">كالوري سناب برو</h1>
              <p className="text-[10px] text-emerald-600 font-bold">بواسطة وسيم قيمري</p>
            </div>
          </div>
          {loading && <Loader2 className="w-5 h-5 animate-spin text-emerald-500" />}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'dashboard' && renderDashboard()}
            {activeTab === 'schedule' && renderSchedule()}
            {activeTab === 'chat' && renderChat()}
            {activeTab === 'settings' && renderSettings()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-black/5 px-6 py-4 z-50">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <NavButton active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<Utensils />} label="الرئيسية" />
          <NavButton active={activeTab === 'schedule'} onClick={() => setActiveTab('schedule')} icon={<Calendar />} label="الجدول" />
          <NavButton active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} icon={<MessageSquare />} label="المدرب" />
          <NavButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings />} label="الإعدادات" />
        </div>
      </nav>

      {/* Hidden Inputs */}
      <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" className="hidden" />

      {/* Manual Meal Modal */}
      <AnimatePresence>
        {showMealModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowMealModal(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl space-y-6"
            >
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold">إضافة وجبة يدوياً</h3>
                <button onClick={() => setShowMealModal(false)}><X className="w-6 h-6 text-gray-400" /></button>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-400">نوع الوجبة</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(['breakfast', 'lunch', 'dinner', 'snack'] as const).map(cat => (
                      <button
                        key={cat}
                        onClick={() => setManualMeal({...manualMeal, category: cat})}
                        className={`py-2 rounded-xl text-[10px] font-bold transition-all ${
                          manualMeal.category === cat ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {cat === 'breakfast' ? 'فطور' : cat === 'lunch' ? 'غداء' : cat === 'dinner' ? 'عشاء' : 'سناك'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-400">اسم الوجبة</label>
                  <input 
                    value={manualMeal.name}
                    onChange={e => setManualMeal({...manualMeal, name: e.target.value})}
                    placeholder="مثلاً: صدر دجاج مشوي"
                    className="w-full bg-gray-50 border-none p-4 rounded-2xl"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-400">ملاحظات التحضير (اختياري)</label>
                  <textarea 
                    value={manualMeal.notes}
                    onChange={e => setManualMeal({...manualMeal, notes: e.target.value})}
                    placeholder="مثلاً: مطبوخ بزيت زيتون..."
                    className="w-full bg-gray-50 border-none p-4 rounded-2xl text-sm resize-none h-20"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-gray-400">الوزن (جرام)</label>
                    <input 
                      type="number"
                      value={manualMeal.weight}
                      onChange={e => setManualMeal({...manualMeal, weight: e.target.value})}
                      placeholder="100"
                      className="w-full bg-gray-50 border-none p-4 rounded-2xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-gray-400">السعرات</label>
                    <div className="relative">
                      <input 
                        type="number"
                        value={manualMeal.calories}
                        onChange={e => setManualMeal({...manualMeal, calories: e.target.value})}
                        placeholder="0"
                        className="w-full bg-gray-50 border-none p-4 rounded-2xl"
                      />
                      <button 
                        onClick={calculateManualCalories}
                        disabled={calculatingManual || !manualMeal.name || !manualMeal.weight}
                        className="absolute left-2 top-2 bottom-2 bg-emerald-100 text-emerald-600 px-3 rounded-xl text-[10px] font-bold disabled:opacity-50"
                      >
                        {calculatingManual ? <Loader2 className="w-3 h-3 animate-spin" /> : 'احسب'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <button 
                onClick={addManualMeal}
                className="w-full py-4 bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-100"
              >
                إضافة الوجبة
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Prep Modal */}
      <AnimatePresence>
        {showPrepModal && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowPrepModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl space-y-6"
            >
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold">تفاصيل الوجبة</h3>
                <button onClick={() => setShowPrepModal(false)}><X className="w-6 h-6 text-gray-400" /></button>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-400">نوع الوجبة</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(['breakfast', 'lunch', 'dinner', 'snack'] as const).map(cat => (
                      <button
                        key={cat}
                        onClick={() => setMealCategory(cat)}
                        className={`py-2 rounded-xl text-[10px] font-bold transition-all ${
                          mealCategory === cat ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {cat === 'breakfast' ? 'فطور' : cat === 'lunch' ? 'غداء' : cat === 'dinner' ? 'عشاء' : 'سناك'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-gray-400">ملاحظات التحضير (اختياري)</label>
                  <textarea 
                    value={mealNotes}
                    onChange={e => setMealNotes(e.target.value)}
                    placeholder="مثلاً: الرز بزيت زيتون، الدجاج في القلاية الهوائية..."
                    className="w-full bg-gray-50 border-none p-4 rounded-2xl text-sm resize-none h-24"
                  />
                </div>
              </div>

              <button 
                onClick={() => {
                  if (pendingImageData) {
                    analyzeImage(pendingImageData, mealCategory, mealNotes);
                    setShowPrepModal(false);
                    setPendingImageData(null);
                  }
                }}
                className="w-full py-4 bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-100"
              >
                بدء التحليل
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showScanModal && scanResult && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowScanModal(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold">تحليل الوجبة</h3>
                <button onClick={() => setShowScanModal(false)}><X className="w-6 h-6 text-gray-400" /></button>
              </div>
              
              <div className="space-y-4">
                {scanResult.items.map((item, idx) => (
                  <div key={idx} className="bg-gray-50 p-4 rounded-2xl space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="font-bold">{item.name}</span>
                      <span className="text-emerald-600 font-black">{item.calories} سعرة</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <label className="text-[10px] font-bold text-gray-400 block mb-1">الوزن (جرام)</label>
                        <input 
                          type="number"
                          value={item.weight || ''}
                          onChange={(e) => updateScanItemWeight(idx, parseInt(e.target.value) || 0)}
                          className="w-full bg-white border border-black/5 p-2 rounded-xl text-sm font-bold"
                        />
                      </div>
                      <div className="flex gap-2 text-[10px] text-gray-500">
                        <span>P: {item.protein}g</span>
                        <span>C: {item.carbs}g</span>
                        <span>F: {item.fats}g</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-4 border-t border-gray-100">
                <div className="flex justify-between items-center mb-6">
                  <span className="font-bold text-gray-400">إجمالي السعرات</span>
                  <span className="text-2xl font-black text-emerald-600">{scanResult.totalCalories}</span>
                </div>
                <button 
                  onClick={confirmScanResult}
                  className="w-full py-4 bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-100"
                >
                  تأكيد وإضافة للسجل
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-1 transition-all ${active ? 'text-emerald-600 scale-110' : 'text-gray-400 hover:text-gray-600'}`}
    >
      <div className={`p-2 rounded-xl ${active ? 'bg-emerald-50' : ''}`}>
        {icon}
      </div>
      <span className="text-[10px] font-bold">{label}</span>
    </button>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <CalorieSnapApp />
    </ErrorBoundary>
  );
}
