import { useId } from 'react';
import { Link } from 'react-router-dom';
import GameCharacter, { CHARACTERS } from './GameCharacters';
import UiIcon from './UiIcon';
import { useAuth } from '../context/AuthContext';

// "Bạn đồng hành": mỗi học sinh được gắn cố định 1 trong 6 linh vật của trò
// chơi Đường đua Khoa học (chọn theo mã tài khoản nên lần nào đăng nhập cũng
// gặp lại đúng bạn đó). Linh vật chào ở trang Luyện đề và làm ảnh đại diện.

export function buddyIdFor(userId) {
  const s = String(userId || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CHARACTERS[h % CHARACTERS.length].id;
}

export function buddyOf(userId) {
  const id = buddyIdFor(userId);
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

// Gọi thân mật bằng tên (chữ cuối của họ tên): "Trần Minh An" -> "An".
export function givenName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Ảnh đại diện tròn: phần đầu của linh vật.
export function BuddyAvatar({ userId, size = 36 }) {
  const buddy = buddyOf(userId);
  return (
    <span className="buddy-avatar" style={{ width: size, height: size, background: buddy.belly }} aria-hidden="true">
      <GameCharacter id={buddy.id} size={size + 6} crop decorative />
    </span>
  );
}

// Linh vật của học sinh đang đăng nhập ngồi chờ ở các trang còn trống
// (chưa có kết quả, chưa có lộ trình...) thay cho biểu tượng khô khan.
export function EmptyBuddy({ mood = 'neutral', size = 88 }) {
  const { user } = useAuth();
  return (
    <div className="empty-state-buddy" aria-hidden="true">
      <GameCharacter id={buddyIdFor(user?.id)} mood={mood} size={size} decorative />
    </div>
  );
}

// Khung chào ở đầu trang Luyện đề: linh vật "nói" với học sinh qua bong bóng
// thoại, nội dung đổi theo tình trạng bài làm.
export function BuddyGreeting({ user, loading, total, pending, firstPendingExamId }) {
  const buddy = buddyOf(user?.id);
  const name = givenName(user?.name);
  const headingId = useId();

  let mood = 'neutral';
  let message = 'Mình đang xem hôm nay có đề nào mới…';
  let action = null;
  if (!loading) {
    if (total === 0) {
      mood = 'happy';
      message = 'Chưa có đề nào được giao. Trong lúc chờ, mình cùng chơi Đường đua Khoa học để luyện thêm nhé!';
      action = { to: '/student/games', icon: 'play', label: 'Vào trò chơi' };
    } else if (pending > 0) {
      message = `Bạn còn ${pending} đề chưa làm. Làm xong là biết ngay phần nào cần ôn thêm.`;
      action = firstPendingExamId
        ? { to: `/student/exams/${firstPendingExamId}`, icon: 'play', label: 'Làm đề ngay' }
        : null;
    } else {
      mood = 'happy';
      message = `Bạn đã làm hết ${total} đề rồi, giỏi quá! Xem lại kết quả để biết chủ đề nào cần ôn.`;
      action = { to: '/student/weak-topics', icon: 'chart', label: 'Xem kết quả' };
    }
  }

  return (
    <section className="buddy-greeting" aria-labelledby={headingId}>
      <div className="buddy-stage">
        <div className="buddy-spot" aria-hidden="true" />
        {/* key theo tâm trạng để hiệu ứng nhảy chạy lại khi đổi sang vui */}
        <span className="buddy-pop">
          <GameCharacter key={mood} id={buddy.id} mood={mood} size={112} className="buddy-figure" decorative />
        </span>
        <span className="buddy-name">{buddy.name}</span>
      </div>

      <div className="buddy-bubble">
        {/* Tên đặt trong thẻ riêng (không dịch) để chế độ tiếng Anh chỉ dịch chữ "Chào" */}
        <h2 className="buddy-hello" id={headingId}>
          {name ? <>Chào <span translate="no">{name}</span>!</> : 'Chào bạn!'}
        </h2>
        <p className="buddy-message">{message}</p>
        {action && (
          <Link to={action.to} className="btn buddy-action">
            <UiIcon name={action.icon} size={15} /> {action.label}
          </Link>
        )}
      </div>

      <svg className="buddy-doodles" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
        {/* nguyên tử */}
        <g transform="translate(118 30)" fill="none" stroke="currentColor" strokeWidth="2.2">
          <ellipse rx="22" ry="8" />
          <ellipse rx="22" ry="8" transform="rotate(60)" />
          <ellipse rx="22" ry="8" transform="rotate(-60)" />
          <circle r="3.2" fill="currentColor" stroke="none" />
        </g>
        {/* chiếc lá */}
        <g transform="translate(40 86) rotate(-25)" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M0 0 C 8 -18, 30 -18, 36 0 C 28 12, 8 12, 0 0 Z" />
          <path d="M2 0 H 30" />
        </g>
        {/* tia điện */}
        <path d="M132 74 l-12 20 h10 l-6 18 l18 -26 h-10 l6 -12 Z" fill="currentColor" />
      </svg>
    </section>
  );
}
