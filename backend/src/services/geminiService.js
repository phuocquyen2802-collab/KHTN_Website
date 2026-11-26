// Service gọi Google Gemini API để sinh roadmap ôn tập và bài tập trắc nghiệm
// tương tự dựa trên các câu hỏi học sinh làm sai thực tế.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

function cleanMathContent(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    // 1. Loại bỏ toàn bộ thẻ SVG, MathML, Style, Script
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<math[\s\S]*?<\/math>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    // 2. Lấy alt từ img nếu có, xóa img
    .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
    .replace(/<img[^>]*>/gi, ' ')
    // 3. Xóa các thẻ HTML còn lại
    .replace(/<[^>]+>/g, ' ')
    // 4. Xóa các dòng/chuỗi tọa độ SVG path MathType rơi rớt ra ngoài
    .replace(/[MmLlHhVvCcSsQqTtAaZz]\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?|\s+-?\d+(?:\.\d+)?)+[a-zA-Z0-9\s,\.\-]*z?/g, ' ')
    .replace(/(?:[cslmhz]-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?)+[a-z]?)+/gi, ' ')
    .replace(/H\d+v\d+[^\s]*/gi, ' ')
    .replace(/M\d+\s+\d+[^\s]*\/>/gi, ' ')
    .replace(/[\w\d,\.-]*\/>/g, ' ')
    .replace(/["']?\s*\/>/g, ' ')
    .replace(/["'»«]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Công thức MathType trong file Word được lưu thành ảnh PNG nhúng base64 (không
// có chữ thay thế). Trước đây cleanMathContent bỏ hết ảnh nên Gemini chỉ đọc
// được "Các nghiệm của phương trình là" mà KHÔNG thấy phương trình, đáp án
// cũng trống - phần phân tích lỗi sai là AI đoán. Nay mỗi ảnh công thức được
// thay bằng 1 dấu mốc ⟦n⟧ và chính ảnh đó được gửi kèm cho Gemini đúng tại vị
// trí ấy (toContentParts), Gemini đọc được công thức trong ảnh.
const FORMULA_IMAGE_RE = /<img[^>]*?\ssrc=["']data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)["'][^>]*>/gi;
const MAX_PROMPT_IMAGES = 150;

// Chữ của đề bài / phương án gửi cho AI. Có truyền `images` thì ảnh công thức
// được giữ lại (dấu mốc ⟦n⟧ + thêm vào `images`), không thì bỏ như cũ.
function questionText(html, images) {
  if (!images) return cleanMathContent(html);
  const marked = String(html || '').replace(FORMULA_IMAGE_RE, (match, mimeType, data) => {
    if (images.length >= MAX_PROMPT_IMAGES) return ' ';
    images.push({ mimeType: mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase(), data: data.replace(/\s+/g, '') });
    return ` ⟦${images.length - 1}⟧ `;
  });
  return cleanMathContent(marked);
}

// Tách prompt có dấu mốc ⟦n⟧ thành các "parts" gửi Gemini: chữ và ảnh xen kẽ.
function toContentParts(prompt, images) {
  if (!images || images.length === 0) return [{ text: prompt }];
  const parts = [];
  prompt.split(/⟦(\d+)⟧/).forEach((piece, i) => {
    if (i % 2 === 1) {
      const image = images[Number(piece)];
      if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    } else if (piece) {
      parts.push({ text: piece });
    }
  });
  return parts;
}

// Gemini hay đặt đáp án đúng ở A (các ví dụ mẫu trong prompt đều là A; đo thực
// tế có lần 16/16 câu, có lần 11/16 câu đáp án A) nên học sinh đoán ra ngay.
// Xáo ngẫu nhiên thứ tự các phương án rồi cập nhật lại đáp án đúng - trừ câu
// có phương án nhắc tới phương án khác ("A và B đều đúng", "Tất cả các đáp án
// trên"...) vì đổi chỗ sẽ sai nghĩa.
const OPTION_REFERENCE_RE = /(?:^|[^A-Za-z])[A-D]\s*(?:,|và|hoặc)\s*[A-D](?:[^A-Za-z]|$)|tất cả|cả hai|cả ba|đều đúng|đều sai|(?:đáp án|phương án|câu) (?:trên|[A-D](?:[^A-Za-z]|$))/i;
function shuffleExerciseOptions(exercises) {
  return (exercises || []).map((ex) => {
    const options = Array.isArray(ex.options) ? ex.options : [];
    const keys = options.map((o) => o.key);
    const correctIndex = keys.indexOf(ex.correctAnswer);
    if (options.length < 2 || correctIndex === -1) return ex;
    if (options.some((o) => OPTION_REFERENCE_RE.test(String(o.text || '')))) return ex;
    const order = options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return {
      ...ex,
      options: order.map((from, to) => ({ ...options[from], key: keys[to] })),
      correctAnswer: keys[order.indexOf(correctIndex)],
    };
  });
}

function buildPrompt(studentName, weakTags = [], wrongQuestions = [], images = null) {
  const tagList = weakTags
    .map((t) => `- "${t.tag}" (tỷ lệ sai: ${Math.round(t.wrongRate * 100)}%, sai ${t.totalWrong}/${t.totalAnswered} câu)`)
    .join('\n');

  let wrongQuestionsSection = '';
  if (wrongQuestions && wrongQuestions.length > 0) {
    const list = wrongQuestions
      .map((q, idx) => {
        const cleanContent = questionText(q.content, images);
        const optionsText = (q.options || [])
          .map((opt) => `    ${opt.key}. ${questionText(opt.text, images)}`)
          .join('\n');
        return `[Câu sai ${idx + 1}] (Chủ đề: ${(q.tags || []).join(', ') || 'Khoa học tự nhiên 8'})
- Đề bài gốc: ${cleanContent}
- 4 đáp án gốc:
${optionsText}
- Đáp án đúng: ${q.correctAnswer || 'A'} | Học sinh đã chọn sai: ${q.selectedOption || 'Chưa chọn'}`;
      })
      .join('\n\n');

    const imageNote = images && images.length > 0
      ? '\n(Công thức trong đề bài và trong các đáp án được gửi kèm dưới dạng ẢNH ngay tại vị trí của nó - hãy đọc kỹ công thức trong ảnh để phân tích đúng lỗi sai và sinh bài tương tự cùng dạng.)'
      : '';
    wrongQuestionsSection = `\nDANH SÁCH CÁC CÂU HỎI CỤ THỂ HỌC SINH VỪA LÀM SAI TRONG ĐỀ THI:${imageNote}
${list}\n`;
  }

  const exerciseCountPerQuestion = 2;
  const totalExercises = wrongQuestions.length > 0
    ? wrongQuestions.length * exerciseCountPerQuestion
    : Math.max(weakTags.length * 3, 3);

  const wantQuestionAnalyses = wrongQuestions && wrongQuestions.length > 0;

  return `Bạn là một giáo viên môn Khoa học tự nhiên lớp 8 tại Việt Nam, dạy theo chương trình Giáo dục phổ thông 2018 (gồm các mạch nội dung: Chất và sự biến đổi của chất - Hoá học; Năng lượng và sự biến đổi - Vật lí; Vật sống - Sinh học). Lý thuyết, công thức, cách giải và bài tập tương tự bám sát phạm vi kiến thức Khoa học tự nhiên 8; chỉ dùng kiến thức lớp trên khi chính câu hỏi học sinh làm sai thuộc phần đó. Dùng tên chất theo danh pháp IUPAC như sách giáo khoa hiện hành (oxygen, hydrogen, nitrogen, hydrochloric acid, sulfuric acid, sodium hydroxide...) và thể tích mol chất khí ở điều kiện chuẩn (25 °C, 1 bar) là 24,79 lít. Bạn đang phân tích bài làm của học sinh "${studentName}" để:
1. Viết một Lộ trình ôn tập tự học chi tiết, chuẩn mực, công thức Vật lí, công thức và phương trình Hoá học viết chuẩn LaTeX 100%.
2. ${wantQuestionAnalyses ? 'Phân tích RIÊNG TỪNG CÂU học sinh đã làm sai (xem "questionAnalyses" trong cấu trúc JSON bên dưới): chỉ ra LỖ HỔNG KIẾN THỨC cụ thể đứng sau lỗi sai đó (thiếu/nhầm kiến thức nền nào khiến học sinh chọn sai đáp án đã chọn) và CÁCH KHẮC PHỤC lỗ hổng đó (nên ôn lại phần lý thuyết/dạng bài nào, luyện tập theo hướng nào) - KHÔNG giải lại chi tiết từng bước của câu hỏi (lời giải chi tiết đầy đủ đã có sẵn trong file đáp án riêng giáo viên phát cho học sinh).' : ''}
3. Phân loại và sinh ra BỘ BÀI TẬP TRẮC NGHIỆM TƯƠNG TỰ THEO TỪNG CHỦ ĐỀ (mỗi câu học sinh làm sai hoặc mỗi chủ đề yếu sinh đúng ${exerciseCountPerQuestion} câu tương tự cùng dạng) với ĐỀ BÀI ĐẦY ĐỦ DỮ KIỆN (số liệu kèm đơn vị, công thức, phương trình hoá học), TUYỆT ĐỐI KHÔNG CỤT ĐỀ.

CHỦ ĐỀ YẾU CỦA HỌC SINH:
${tagList}
${wrongQuestionsSection}
HÃY TRẢ VỀ DUY NHẤT MỘT OBJECT JSON THEO ĐÚNG CẤU TRÚC SAU (KHÔNG KÈM BẤT KỲ VĂN BẢN NÀO NGOÀI JSON):

{
  "summary": "Đoạn văn 4-6 câu: Động viên em ${studentName}, nêu rõ từng nội dung/dạng bài em đang bị hổng (Vật lí, Hoá học hay Sinh học) và định hướng cách ôn tập từ cơ bản đến nâng cao.",
  "steps": [
    {
      "order": 1,
      "tag": "Mol và tỉ khối chất khí",
      "theory": "1. Số mol chất: $n = \\\\frac{m}{M}$ (mol), trong đó $m$ là khối lượng chất (gam), $M$ là khối lượng mol (g/mol).\\n2. Ở điều kiện chuẩn (25 °C, 1 bar), 1 mol chất khí bất kì chiếm thể tích 24,79 lít: $V = 24{,}79 \\\\cdot n$ (lít).\\n3. Tỉ khối của khí A đối với khí B: $d_{A/B} = \\\\frac{M_A}{M_B}$; tỉ khối của khí A đối với không khí: $d_{A/kk} = \\\\frac{M_A}{29}$.",
      "commonMistake": "- Lỗi 1: Nhầm khối lượng mol phân tử với khối lượng nguyên tử, ví dụ lấy $M_{\\\\mathrm{O_2}} = 16$ g/mol thay vì $32$ g/mol.\\n- Lỗi 2: Dùng 22,4 lít (điều kiện cũ) thay vì 24,79 lít cho 1 mol khí ở điều kiện chuẩn.",
      "action": "Bước 1: Viết đúng công thức hoá học của chất, tính khối lượng mol $M$ bằng tổng khối lượng các nguyên tử trong phân tử.\\nBước 2: Tính số mol theo $n = \\\\frac{m}{M}$ hoặc $n = \\\\frac{V}{24{,}79}$.\\nBước 3: Kiểm tra lại đơn vị (gam, lít, mol) trước khi chọn đáp án."
    }
  ],
${wantQuestionAnalyses ? `  "questionAnalyses": [
    {
      "questionIndex": 1,
      "mistakeAnalysis": "Học sinh tính khối lượng mol của khí oxygen bằng khối lượng nguyên tử O ($16$ g/mol) thay vì khối lượng mol phân tử $\\\\mathrm{O_2}$ ($32$ g/mol) nên số mol tính ra gấp đôi giá trị đúng - đây là lỗ hổng về phân biệt nguyên tử và phân tử của đơn chất khí.",
      "correctSolution": "Ôn lại cách tính khối lượng mol phân tử từ công thức hoá học (cộng khối lượng của tất cả nguyên tử trong phân tử), đặc biệt với các đơn chất khí $\\\\mathrm{O_2}$, $\\\\mathrm{H_2}$, $\\\\mathrm{N_2}$, $\\\\mathrm{Cl_2}$. Nên luyện thêm 3-5 bài tính số mol từ khối lượng của các khí này để ghi nhớ chắc."
    }
  ],
` : ''}  "exercises": [
    {
      "content": "Số mol của $8$ gam khí oxygen ($\\\\mathrm{O_2}$) là (cho $\\\\mathrm{O} = 16$):",
      "options": [
        { "key": "A", "text": "$0{,}25$ mol" },
        { "key": "B", "text": "$0{,}5$ mol" },
        { "key": "C", "text": "$2$ mol" },
        { "key": "D", "text": "$4$ mol" }
      ],
      "correctAnswer": "A",
      "tags": ["Mol và tỉ khối chất khí"]
    },
    {
      "content": "Một thùng cao $1{,}2$ m đựng đầy nước. Biết trọng lượng riêng của nước là $d = 10\\\\,000$ N/m³. Áp suất của nước tác dụng lên đáy thùng là:",
      "options": [
        { "key": "A", "text": "$12\\\\,000$ Pa" },
        { "key": "B", "text": "$1\\\\,200$ Pa" },
        { "key": "C", "text": "$120\\\\,000$ Pa" },
        { "key": "D", "text": "$8\\\\,333$ Pa" }
      ],
      "correctAnswer": "A",
      "tags": ["Áp suất chất lỏng - Áp suất khí quyển"]
    },
    {
      "content": "Cho phản ứng: $\\\\mathrm{Zn + 2HCl \\\\rightarrow ZnCl_2 + H_2}$. Hoà tan hoàn toàn $6{,}5$ gam kẽm trong dung dịch hydrochloric acid dư. Thể tích khí hydrogen thu được ở điều kiện chuẩn (25 °C, 1 bar) là (cho $\\\\mathrm{Zn} = 65$):",
      "options": [
        { "key": "A", "text": "$2{,}479$ lít" },
        { "key": "B", "text": "$2{,}24$ lít" },
        { "key": "C", "text": "$4{,}958$ lít" },
        { "key": "D", "text": "$24{,}79$ lít" }
      ],
      "correctAnswer": "A",
      "tags": ["Tính theo phương trình hoá học"]
    },
    {
      "content": "Cơ quan nào sau đây thuộc hệ tuần hoàn của cơ thể người?",
      "options": [
        { "key": "A", "text": "Tim" },
        { "key": "B", "text": "Phổi" },
        { "key": "C", "text": "Dạ dày" },
        { "key": "D", "text": "Thận" }
      ],
      "correctAnswer": "A",
      "tags": ["Máu và hệ tuần hoàn của cơ thể người"]
    }
  ]
}

QUY TẮC SỐNG CÒN BẮT BUỘC:
1. PHÂN LOẠI BÀI TẬP THEO CHỦ ĐỀ:
   - Trong mỗi phần tử 'exercises', trường 'tags' BẮT BUỘC chứa đúng tên chủ đề tương ứng (ví dụ: ['Phản ứng hoá học'], ['Mol và tỉ khối chất khí'], ['Lực đẩy Archimedes'], ['Cường độ dòng điện và hiệu điện thế'], ['Hệ hô hấp ở người']).
   - Tên chủ đề trong 'tags' phải khớp với tên chủ đề trong 'steps' (và giữ nguyên tên chủ đề yếu đã cho ở trên) để hệ thống nhóm bài tập theo từng chủ đề.
2. KHÔNG DÙNG HÌNH VẼ (hệ thống không hiển thị được hình vẽ, sơ đồ do AI tự tạo):
   - KHÔNG thêm trường 'diagram' vào bất kỳ bài tập nào.
   - KHÔNG viết "như hình vẽ", "quan sát hình bên", "sơ đồ sau"... Khi câu hỏi cần mạch điện, dụng cụ thí nghiệm, đòn bẩy, cơ quan trong cơ thể, chuỗi thức ăn/lưới thức ăn..., hãy MÔ TẢ BẰNG LỜI đầy đủ (ví dụ: "Mạch điện gồm nguồn điện, công tắc K đóng và hai bóng đèn Đ1, Đ2 mắc nối tiếp" hoặc "Chuỗi thức ăn: cỏ → châu chấu → ếch → rắn").
   - KHÔNG chèn mã vẽ vector, SVG path, toạ độ rác (như c0,-2... H40000...) vào 'content'.
3. ĐỀ BÀI CÂU HỎI VÀ ĐÁP ÁN PHẢI CHUẨN XÁC VÀ ĐẦY ĐỦ DỮ KIỆN:
   - Câu hỏi tính toán (Vật lí, Hoá học) trong 'content' BẮT BUỘC cho đủ số liệu kèm đơn vị, các hằng số cần dùng (trọng lượng riêng, khối lượng nguyên tử...) và phương trình hoá học (nếu có) bọc trong $...$; câu hỏi lý thuyết (đặc biệt phần Sinh học) phải nêu rõ ràng, đủ ý, chỉ có đúng 1 đáp án đúng.
   - Kết quả của đáp án đúng PHẢI được tính lại chính xác; các phương án nhiễu nên đến từ lỗi thường gặp (nhầm đơn vị, nhầm công thức, quên cân bằng phương trình, nhầm khái niệm).
   - Ví dụ đúng: 'Đốt cháy hoàn toàn $3{,}1$ gam phosphorus trong khí oxygen theo phương trình $\\\\mathrm{4P + 5O_2 \\\\xrightarrow{t^o} 2P_2O_5}$. Khối lượng $\\\\mathrm{P_2O_5}$ thu được là (cho $\\\\mathrm{P} = 31$, $\\\\mathrm{O} = 16$):'
4. TẤT CẢ CÔNG THỨC, ĐẠI LƯỢNG VÀ PHƯƠNG TRÌNH HOÁ HỌC PHẢI BỌC TRONG $...$:
   - BẮT BUỘC: $p = \\\\frac{F}{S}$, $D = \\\\frac{m}{V}$, $F_A = d \\\\cdot V$, $M = F \\\\cdot d$, $I$, $U$, $n = \\\\frac{m}{M}$, $C\\\\% = \\\\frac{m_{ct}}{m_{dd}} \\\\cdot 100\\\\%$, $\\\\mathrm{H_2SO_4}$, $\\\\mathrm{2H_2 + O_2 \\\\xrightarrow{t^o} 2H_2O}$.
   - Công thức hoá học viết bằng $\\\\mathrm{...}$ với chỉ số dưới dùng dấu _ (ví dụ $\\\\mathrm{CaCO_3}$, $\\\\mathrm{Fe_2O_3}$). Điều kiện phản ứng ghi trên mũi tên bằng $\\\\xrightarrow{...}$ (ví dụ $\\\\xrightarrow{t^o}$, $\\\\xrightarrow{\\\\mathrm{MnO_2}}$).
   - KHÔNG đặt chữ tiếng Việt có dấu bên trong $...$ (viết chữ ra ngoài công thức). Đơn vị đo (Pa, N/m², g/mol, °C, lít...) viết ngoài công thức như ví dụ ở trên.
   - TUYỆT ĐỐI KHÔNG dùng dấu backtick (\`...\`) để bọc công thức.
5. SỐ LƯỢNG: Sinh ĐÚNG ${totalExercises} câu hỏi trắc nghiệm tương tự, phân bố đều theo từng chủ đề yếu.${wantQuestionAnalyses ? `
6. PHÂN TÍCH TỪNG CÂU SAI ("questionAnalyses") LÀ BẮT BUỘC:
   - PHẢI có ĐÚNG ${wrongQuestions.length} phần tử trong 'questionAnalyses', mỗi phần tử ứng với ĐÚNG 1 câu trong "DANH SÁCH CÁC CÂU HỎI CỤ THỂ" theo thứ tự [Câu sai 1], [Câu sai 2], ... - trường 'questionIndex' = số thứ tự đó (1, 2, 3...).
   - 'mistakeAnalysis' (LỖ HỔNG KIẾN THỨC): chỉ ra CỤ THỂ đây là lỗ hổng kiến thức nào (thiếu công thức gì, nhầm quy tắc/điều kiện gì, hiểu sai khái niệm gì) khiến học sinh chọn nhầm đáp án đã chọn - KHÔNG viết chung chung kiểu "học sinh chưa nắm vững kiến thức", và KHÔNG giải lại chi tiết bài tập.
   - 'correctSolution' (CÁCH KHẮC PHỤC): đưa ra HƯỚNG KHẮC PHỤC lỗ hổng đó cho học sinh - nên ôn lại phần lý thuyết/công thức/dạng bài nào, cần luyện tập thêm theo hướng nào để không lặp lại lỗi này - TUYỆT ĐỐI KHÔNG trình bày lời giải chi tiết từng "Bước 1, Bước 2..." của CHÍNH câu hỏi đó vì lời giải chi tiết đầy đủ đã có sẵn trong file đáp án riêng giáo viên phát cho học sinh, viết lại ở đây là thừa và trùng lặp.` : ''}`;
}

const FALLBACK_MODELS = Array.from(new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
].filter(Boolean)));

function safeJsonParse(rawText) {
  if (!rawText) return null;
  let cleaned = rawText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // QUAN TRỌNG - sửa TRƯỚC khi parse (không phải chỉ khi parse báo lỗi):
  // \b \f \r \t đều là escape HỢP LỆ của JSON, nên nếu Gemini lỡ dùng 1 dấu
  // \ cho lệnh LaTeX bắt đầu đúng các chữ này (\right, \rho, \tan, \tau,
  // \to, \frac, \forall, \beta, \begin...), JSON.parse sẽ ÂM THẦM "nuốt"
  // nó thành ký tự điều khiển (KHÔNG báo lỗi) - ví dụ "\right)" bị hiểu
  // thành ký tự CR + "ight)", mất chữ "r" - nên toàn bộ cơ chế sửa lỗi ở
  // các bước try/catch bên dưới KHÔNG BAO GIỜ được chạy tới (vì JSON.parse
  // "thành công" ngay từ đầu, chỉ là sai nội dung). Escape JSON thật luôn
  // đứng 1 mình (theo sau là dấu " hoặc \), còn lệnh LaTeX luôn có thêm chữ
  // cái ngay sau - dùng đặc điểm này để phân biệt, escape kép (\\) an toàn
  // cho trường hợp có chữ cái theo sau. KHÔNG đụng \n (dùng cho xuống dòng
  // thật trong nội dung) và \u (escape Unicode).
  cleaned = cleaned.replace(/(?<!\\)\\([bfrt])(?=[a-zA-Z])/g, '\\\\$1');

  // Thử parse chuẩn trước
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Nếu AI trả về backslash đơn cho các lệnh LaTeX (\log, \Delta, \frac, \neq...),
    // ta tìm và escape tất cả các dấu \ không thuộc tập escape hợp lệ của JSON (\", \\, \/, \b, \f, \n, \r, \t, \uXXXX)
    try {
      const fixed = cleaned.replace(/\\(?:[^"\\/bfnrtu]|u(?![\da-fA-F]{4}))/g, (match) => {
        return '\\\\' + match.slice(1);
      });
      return JSON.parse(fixed);
    } catch (e2) {
      try {
        // Quét bên trong các chuỗi đóng mở ngoặc kép để sửa escape
        const fixed2 = cleaned.replace(/"((?:[^"\\]|\\.)*)"/g, (match) => {
          const inner = match.slice(1, -1);
          const fixedInner = inner.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
          return '"' + fixedInner + '"';
        });
        return JSON.parse(fixed2);
      } catch (e3) {
        try {
          return Function('"use strict";return (' + cleaned + ')')();
        } catch (e4) {
          throw err;
        }
      }
    }
  }
}

// Tự động kiểm tra và chuẩn hóa các biểu thức toán học
function normalizeMathText(text) {
  if (!text || typeof text !== 'string') return text;

  let res = text
    .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, '')
    .replace(/^[\s]*\*\*[\s]*$/gm, '')
    .replace(/^[\s]*\*[\s]*$/gm, '');

  // 1. Chuyển đổi backtick markdown `...` sang $...$
  res = res.replace(/`([^`\n\r]+?)`/g, (match, inner) => {
    const trimmed = inner.trim();
    if (!trimmed) return match;
    if (trimmed.startsWith('$') && trimmed.endsWith('$')) return trimmed;
    return `$${trimmed}$`;
  });

  // 2. Chuyển đổi \left\{ \begin{aligned} ... \end{aligned} \right. (và biến
  // thể dùng ngoặc vuông \left[ ... \right. để biểu diễn "hoặc" giữa các họ
  // nghiệm - cách viết phổ biến trong SGK Việt Nam) sang \begin{cases} ...
  // \end{cases} - KaTeX không tự hỗ trợ ngoặc vuông bọc \aligned nên nếu
  // không đổi, công thức vỡ hoàn toàn không hiển thị được.
  res = res.replace(/\\left(?:\\\{|\[)\s*\\begin\{aligned\}([\s\S]*?)\\end\{aligned\}\s*\\right(?:\.|\])?/g, (_match, inner) => {
    const cleanedInner = inner.replace(/&/g, '').trim();
    return `\\begin{cases} ${cleanedInner} \\end{cases}`;
  });

  // 3. Khắc phục phân tách điều kiện và lỗi unicode
  // QUAN TRỌNG: đôi khi Gemini không dùng lệnh LaTeX \neq mà lại chèn thẳng
  // 1 ký tự unicode "trông giống" dấu khác (≠, ⊟ boxminus, ≢, ∄...) do lỗi
  // sinh token - các ký tự này gần như KHÔNG BAO GIỜ có nghĩa hợp lệ nào
  // khác trong công thức Vật lí/Hoá học, nên thay thế THẲNG về \neq trước, áp dụng
  // rộng (không chỉ riêng khuôn mẫu "a > 0, a ≠ 1") để chặn lỗi dạng này ở
  // mọi vị trí xuất hiện.
  res = res.replace(/[≠⊟≢∄]/g, ' \\neq ');

  res = res
    .replace(/\$\s*0\s*<\s*\$?\s*a\s*\\neq\s*1\s*\$?/gi, '$0 < a \\neq 1$')
    .replace(/\$\s*0\s*<\s*\$?\s*a\s*≠\s*1\s*\$?/gi, '$0 < a \\neq 1$')
    .replace(/(?:\(\s*với|với)\s*\$?\s*0\s*<\s*a\s*\\neq\s*1\s*\$?\s*\)?/gi, '(với $0 < a \\neq 1$)')
    .replace(/(?:\(\s*với|với)\s*\$?\s*a\s*>\s*0\s*[,;\s]+a\s*\\neq\s*1\s*\$?\s*\)?/gi, '(với $a > 0, a \\neq 1$)')
    .replace(/a\s*∄\s*1/gi, '$a \\neq 1$')
    .replace(/([a-zA-Z0-9])\s*neq\s*([0-9a-zA-Z])/g, '$1 \\neq $2')
    .replace(/(?:^|\s)neq\s*([0-9a-zA-Z])/g, ' $\\neq $1$ ')
    .replace(/(?:^|\s)Leftrightarrow(?:\s|$)/g, ' $\\Leftrightarrow$ ')
    .replace(/(?:^|\s)Rightarrow(?:\s|$)/g, ' $\\Rightarrow$ ')
    .replace(/[\r\n]+\s*\)\s*\.?/g, '). ')
    .replace(/[\r\n]+\s*\)\s*/g, ') ')
    .replace(/(\.\s*)-\s*\$/g, '$1\n- $');

  return res;
}

function normalizeAIOutput(data) {
  if (!data || typeof data !== 'object') return data;

  if (typeof data.summary === 'string') {
    data.summary = normalizeMathText(data.summary);
  }

  if (Array.isArray(data.steps)) {
    data.steps = data.steps.map((step) => {
      if (typeof step === 'string') return normalizeMathText(step);
      return {
        ...step,
        tag: normalizeMathText(step.tag || step.title),
        theory: normalizeMathText(step.theory),
        commonMistake: normalizeMathText(step.commonMistake),
        action: normalizeMathText(step.action),
      };
    });
  }

  if (Array.isArray(data.exercises)) {
    data.exercises = data.exercises.map((ex) => ({
      ...ex,
      content: normalizeMathText(ex.content),
      options: (ex.options || []).map((opt) => ({
        ...opt,
        text: normalizeMathText(opt.text),
      })),
      tags: (ex.tags || []).map(normalizeMathText),
    }));
  }

  if (Array.isArray(data.questionAnalyses)) {
    data.questionAnalyses = data.questionAnalyses.map((qa) => ({
      ...qa,
      mistakeAnalysis: normalizeMathText(qa.mistakeAnalysis),
      correctSolution: normalizeMathText(qa.correctSolution),
    }));
  }

  return data;
}

// Gọi Gemini API với cơ chế tự động thử model dự phòng nếu model chính bị quá tải (503/429)
async function generateRoadmapAndExercises(studentName, weakTags = [], wrongQuestions = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Chưa cấu hình GEMINI_API_KEY trong backend/.env. Xem hướng dẫn lấy key tại docs/GEMINI_SETUP.md'
    );
  }

  const images = [];
  const prompt = buildPrompt(studentName, weakTags, wrongQuestions, images);
  const parts = toContentParts(prompt, images);
  let lastError = null;

  for (const modelName of FALLBACK_MODELS) {
    const startedAt = Date.now();
    const seconds = () => ((Date.now() - startedAt) / 1000).toFixed(1);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
            maxOutputTokens: 32768,
            // Ảnh công thức rất nhỏ: độ phân giải thấp vẫn đọc rõ mà tốn ít token
            // hơn nhiều (mặc định ~1.100 token/ảnh, 8 câu sai ~54 ảnh = ~60.000 token).
            ...(images.length > 0 ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
          },
        }),
        // Model bị treo (đo thực tế có model không phản hồi quá 90 giây) thì bỏ, thử model dự phòng.
        signal: AbortSignal.timeout(180000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        // 429 = API key vượt giới hạn số lần gọi; 503 = model của Google đang quá tải.
        console.warn(`[Gemini] Model ${modelName} tạm thời phản hồi (${response.status}) sau ${seconds()}s, tự động chuyển sang model dự phòng tiếp theo...`);
        lastError = new Error(`Gemini API (${modelName}) lỗi ${response.status}: ${errorBody}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        lastError = new Error(`Gemini API (${modelName}) không trả về nội dung text`);
        continue;
      }

      const parsed = safeJsonParse(rawText);

      if (!parsed || !Array.isArray(parsed.steps) || !Array.isArray(parsed.exercises)) {
        lastError = new Error('Cấu trúc JSON từ Gemini thiếu "steps" hoặc "exercises"');
        continue;
      }

      console.log(`[Gemini] Lộ trình: ${modelName} trả lời xong sau ${seconds()}s (${images.length} ảnh công thức)`);
      const result = normalizeAIOutput(parsed);
      result.exercises = shuffleExerciseOptions(result.exercises);
      return result;
    } catch (err) {
      console.warn(`[Gemini] Lỗi gọi model ${modelName} sau ${seconds()}s:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('Không thể kết nối tới Google Gemini API.');
}

// ---------------------------------------------------------------------------
// Trò chuyện trực tiếp với Gemini AI về Khoa học tự nhiên 8 (trang Trợ lý AI)
//
// Ưu tiên tốc độ: đo thực tế (11/2026) bản Flash-Lite bắt đầu trả lời sau
// ~1 giây, còn các bản Flash phải "suy nghĩ" ~1000 token và xếp hàng nên mất
// 5-20 giây mới có chữ đầu tiên. Vì vậy trợ lý chat dùng Flash-Lite (đổi được
// qua GEMINI_CHAT_MODEL), trả lời dạng stream để chữ hiện dần, và nếu một
// model chưa trả chữ nào sau CHAT_FIRST_TOKEN_TIMEOUT_MS thì bỏ, chuyển sang
// model dự phòng. Phần sinh lộ trình/bài tập ở trên vẫn dùng GEMINI_MODEL.
// ---------------------------------------------------------------------------
const CHAT_MODELS = Array.from(new Set([
  process.env.GEMINI_CHAT_MODEL,
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash',
].filter(Boolean)));
const CHAT_FIRST_TOKEN_TIMEOUT_MS = 20000;
const CHAT_TOTAL_TIMEOUT_MS = 120000;
// Model trả 404 (không còn/không tồn tại) thì bỏ qua 1 giờ, khỏi mất thời gian thử lại mỗi câu hỏi.
const unavailableUntil = new Map();

// Gemini 3 trở lên: giảm mức suy nghĩ để trả lời nhanh (Flash-Lite mặc định gần như không suy nghĩ).
function chatThinkingConfig(modelName) {
  return /^gemini-([3-9]|\d{2,})/.test(modelName) ? { thinkingLevel: 'low' } : undefined;
}

function buildChatContents(messages, userContext) {
  const roleName = userContext.role === 'teacher' ? 'Thầy/Cô giáo' : 'Học sinh';
  const userName = userContext.name || 'Người dùng';

  const systemInstruction = `Bạn là trợ lý AI của "Science IQ - Phần mềm học Khoa học tự nhiên 8 cùng AI", chuyên gia môn Khoa học tự nhiên lớp 8 tại Việt Nam (chương trình Giáo dục phổ thông 2018). Khi tự giới thiệu, hãy xưng là trợ lý AI của Science IQ.
Bạn đang trò chuyện và hỗ trợ trực tiếp cho ${roleName} "${userName}".
Nhiệm vụ của bạn:
1. Giải đáp chi tiết, từng bước các câu hỏi và bài tập Khoa học tự nhiên 8:
   - Hoá học: sử dụng hoá chất, thiết bị cơ bản trong phòng thí nghiệm; biến đổi vật lí và biến đổi hoá học; phản ứng hoá học và năng lượng của phản ứng; mol, khối lượng mol, thể tích mol chất khí, tỉ khối chất khí; dung dịch, độ tan, nồng độ phần trăm, nồng độ mol; định luật bảo toàn khối lượng, phương trình hoá học, tính theo phương trình hoá học, hiệu suất phản ứng; tốc độ phản ứng và chất xúc tác; acid, base, thang pH, oxide, muối, phân bón hoá học.
   - Vật lí: khối lượng riêng; áp suất trên một bề mặt, áp suất chất lỏng, áp suất khí quyển; lực đẩy Archimedes; tác dụng làm quay của lực, moment lực, đòn bẩy; hiện tượng nhiễm điện do cọ xát, dòng điện, nguồn điện, mạch điện đơn giản, tác dụng của dòng điện, cường độ dòng điện và hiệu điện thế; năng lượng nhiệt và nội năng, dẫn nhiệt, đối lưu, bức xạ nhiệt, sự nở vì nhiệt.
   - Sinh học: khái quát về cơ thể người; hệ vận động; dinh dưỡng và tiêu hoá; máu và hệ tuần hoàn; hệ hô hấp; hệ bài tiết và môi trường trong cơ thể; hệ thần kinh và các giác quan; hệ nội tiết; da và điều hoà thân nhiệt; sinh sản ở người; môi trường và các nhân tố sinh thái; quần thể, quần xã, hệ sinh thái, sinh quyển; cân bằng tự nhiên và bảo vệ môi trường.
   Trình bày theo cách học sinh lớp 8 đã được học: dùng tên chất theo danh pháp IUPAC như sách giáo khoa hiện hành (oxygen, hydrogen, hydrochloric acid, sodium hydroxide...), thể tích mol chất khí ở điều kiện chuẩn (25 °C, 1 bar) là 24,79 lít. Nếu được hỏi kiến thức lớp khác vẫn hỗ trợ, nhưng ưu tiên chương trình Khoa học tự nhiên 8.
2. Giải thích bản chất hiện tượng tự nhiên, cách tiến hành và kết quả thí nghiệm, lưu ý an toàn trong phòng thí nghiệm, liên hệ thực tế và các bẫy trắc nghiệm hay gặp (nhầm đơn vị, nhầm công thức, quên cân bằng phương trình hoá học, nhầm khái niệm).
3. Soạn câu hỏi trắc nghiệm, bài tập tự luyện tương tự theo yêu cầu.
4. Trả lời thân thiện, sư phạm, rõ ràng, gãy gọn.

QUY TẮC CÔNG THỨC VÀ BỐ CỤC BẮT BUỘC:
- Mọi công thức, đại lượng vật lí, công thức hoá học, phương trình hoá học PHẢI bọc trong cặp dấu $...$ (nếu trong dòng) hoặc $$...$$ (nếu hiển thị khối trung tâm).
- Dùng cú pháp LaTeX chuẩn: $p = \\frac{F}{S}$, $D = \\frac{m}{V}$, $F_A = d \\cdot V$, $M = F \\cdot d$, $n = \\frac{m}{M}$, $C\\% = \\frac{m_{ct}}{m_{dd}} \\cdot 100\\%$, $\\mathrm{H_2SO_4}$, $\\mathrm{2H_2 + O_2 \\xrightarrow{t^o} 2H_2O}$, $\\mathrm{2H_2O_2 \\xrightarrow{MnO_2} 2H_2O + O_2}$.
- KHÔNG đặt chữ tiếng Việt có dấu bên trong $...$; đơn vị đo (Pa, N/m², g/mol, °C, lít...) viết ngoài công thức.
- TUYỆT ĐỐI KHÔNG dùng backtick (\`...\`) cho công thức.
- TRÌNH BÀY GỌN GÀNG, ĐẸP MẮT: KHÔNG dùng các đường kẻ rác (---, ___), KHÔNG lạm dụng các dấu thăng (####, ###), KHÔNG để các ký tự markdown thừa (như ** đứng một mình). Dùng gạch đầu dòng rõ ràng (- hoặc •) và số thứ tự (1., 2., Bước 1:, Bước 2:).`;

  // Người dùng đang xem giao diện tiếng Anh: yêu cầu AI trả lời bằng tiếng Anh.
  const languageRule = userContext.lang === 'en'
    ? '\n\nNGÔN NGỮ: Người dùng đang dùng giao diện tiếng Anh. LUÔN trả lời hoàn toàn bằng tiếng Anh (English), kể cả khi câu hỏi viết bằng tiếng Việt; dùng thuật ngữ khoa học tiếng Anh chuẩn (Step 1, Step 2, ...).'
    : '';

  // Chuyển đổi lịch sử chat sang định dạng Gemini
  const contents = [];
  
  // Tin nhắn hệ thống ban đầu đưa vào lượt đầu tiên
  let isFirst = true;
  for (const m of messages) {
    const role = m.role === 'assistant' || m.role === 'model' ? 'model' : 'user';
    let text = m.content || '';
    if (isFirst && role === 'user') {
      text = `[CHỈ DẪN HỆ THỐNG]: ${systemInstruction}${languageRule}\n\n[CÂU HỎI TỪ ${roleName.toUpperCase()} ${userName.toUpperCase()}]: ${text}`;
      isFirst = false;
    }
    contents.push({
      role,
      parts: [{ text }],
    });
  }

  if (contents.length === 0) {
    contents.push({
      role: 'user',
      parts: [{ text: systemInstruction + languageRule + '\n\nXin chào Trợ lý AI!' }],
    });
  }

  return contents;
}

// Gọi 1 model ở chế độ stream (SSE). onDelta nhận từng đoạn chữ ngay khi có.
// Lỗi xảy ra SAU khi đã gửi chữ cho người dùng được đánh dấu committed = true
// (không chuyển model khác nữa vì người dùng đã thấy nửa câu trả lời).
async function streamOneChatModel(modelName, contents, apiKey, onDelta, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort);
  }
  let gotText = false;
  const firstTokenTimer = setTimeout(abort, CHAT_FIRST_TOKEN_TIMEOUT_MS);
  const totalTimer = setTimeout(abort, CHAT_TOTAL_TIMEOUT_MS);

  try {
    const generationConfig = { temperature: 0.6, maxOutputTokens: 8192 };
    const thinkingConfig = chatThinkingConfig(modelName);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 404) unavailableUntil.set(modelName, Date.now() + 60 * 60 * 1000);
      throw new Error(`Gemini API (${modelName}) lỗi ${response.status}: ${errorBody.slice(0, 300)}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        let data;
        try { data = JSON.parse(line.slice(5)); } catch { continue; }
        const text = (data.candidates?.[0]?.content?.parts || [])
          .filter((p) => !p.thought)
          .map((p) => p.text || '')
          .join('');
        if (!text) continue;
        if (!gotText) {
          gotText = true;
          clearTimeout(firstTokenTimer);
        }
        full += text;
        onDelta(text);
      }
    }

    if (!full) throw new Error(`Model ${modelName} không trả về nội dung`);
    return full;
  } catch (err) {
    const error = controller.signal.aborted && !signal?.aborted
      ? new Error(gotText ? `Gemini (${modelName}) trả lời quá lâu` : `Gemini (${modelName}) chưa phản hồi sau ${CHAT_FIRST_TOKEN_TIMEOUT_MS / 1000} giây`)
      : err;
    error.committed = gotText;
    throw error;
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

// Trả lời dạng stream: onDelta(text) cho từng đoạn chữ, trả về toàn bộ câu
// trả lời đã chuẩn hoá công thức khi xong. signal: huỷ khi người dùng rời trang.
async function streamChatWithGemini(messages = [], userContext = {}, onDelta = () => {}, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trong backend/.env');
  }

  const contents = buildChatContents(messages, userContext);
  const now = Date.now();
  const models = CHAT_MODELS.filter((m) => !(unavailableUntil.get(m) > now));
  let lastError = null;

  for (const modelName of models.length ? models : CHAT_MODELS) {
    if (signal?.aborted) break;
    try {
      const full = await streamOneChatModel(modelName, contents, apiKey, onDelta, signal);
      return normalizeMathText(full);
    } catch (err) {
      if (err.committed || signal?.aborted) throw err;
      console.warn(`[Gemini Chat] ${err.message} - chuyển sang model dự phòng...`);
      lastError = err;
    }
  }

  throw lastError || new Error('Không thể kết nối tới Google Gemini API.');
}

// Bản không stream (giữ cho các nơi gọi cũ): chờ đủ câu trả lời rồi trả về.
async function chatWithGemini(messages = [], userContext = {}) {
  return streamChatWithGemini(messages, userContext);
}

module.exports = {
  generateRoadmapAndExercises,
  chatWithGemini,
  streamChatWithGemini,
};
