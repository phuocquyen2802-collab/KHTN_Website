// Logo Science IQ: bình tam giác (bình Erlenmeyer) của phòng thí nghiệm
// Khoa học tự nhiên trên nền xanh, bọt khí tô màu hổ phách tượng trưng cho
// "insight" - chỗ hệ thống chỉ ra học sinh cần ôn lại. Dùng chung cho
// sidebar, trang đăng nhập và favicon (frontend/public/favicon.svg).
const FLASK = 'M14.2 6.5V13L8 23.2Q7 25.5 9.6 25.5H22.4Q25 25.5 24 23.2L17.8 13V6.5';
const LIQUID = 'M10.6 19H21.4L24 23.2Q25 25.5 22.4 25.5H9.6Q7 25.5 8 23.2Z';

export default function BrandMark({ size = 32, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill="var(--primary, #4f63f7)" />
      <path d={LIQUID} fill="#ffffff" fillOpacity="0.24" />
      <path d={FLASK} fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.6 6.5H19.4" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="13.6" cy="22.4" r="1.2" fill="#ffffff" />
      <circle cx="16" cy="15.6" r="0.9" fill="#ffffff" fillOpacity="0.8" />
      <circle cx="18.7" cy="21.5" r="2.4" fill="var(--insight, #ffb31f)" stroke="var(--primary, #4f63f7)" strokeWidth="1.1" />
    </svg>
  );
}
