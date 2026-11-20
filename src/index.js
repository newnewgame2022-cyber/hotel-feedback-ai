// Hệ thống quản lý phản hồi khách sạn: Cloudflare Worker + D1 + Workers AI
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CATS = ['cleanliness', 'staff', 'food', 'facilities', 'location', 'price', 'checkin', 'noise'];
const clamp = (x) => Math.max(-1, Math.min(1, x));
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });

// ---------- Phân tích bằng luật (dự phòng khi AI lỗi / hết quota) ----------
const norm = (s) => s.toLowerCase().replace(/yêu/g, 'love').replace(/yếu/g, 'weak').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const KW = {
  cleanliness: 've sinh,sach,ban,khan,ga giuong,nha tam,mui,con gian,con chuot,phong tam',
  staff: 'nhan vien,le tan,phuc vu,thai do,nhiet tinh,than thien,quan ly',
  food: 'an sang,buffet,nha hang,mon an,do an,bua,nau',
  facilities: 'wifi,internet,ho boi,dieu hoa,may lanh,thang may,gym,nuoc nong,tivi,tien nghi',
  location: 'vi tri,gan,xa,trung tam,bai bien,di chuyen',
  price: 'gia,gia ca,mac,re,doi gia,xung dang',
  checkin: 'check in,check-in,nhan phong,tra phong,thu tuc,cho doi',
  noise: 'on,on ao,tieng on,an ninh,mat do,trom',
};
const POS = 'tot,tuyet,dep,sach,than thien,nhiet tinh,ngon,thoai mai,hai long,yen tinh,chuyen nghiep,xuat sac,rong rai,thom,tien loi,nhanh,chu dao,tuyet voi,love'.split(',');
const NEG = 'te,ban,hoi,on,on ao,cham,kem,that vong,mac,hong,cu,xuong cap,nhat,thieu,weak,chua duoc ve sinh lam ky,chua duoc ve sinh ky,ve sinh khong ky,khong duoc ve sinh'.split(',');
const J = (w) => w.replace(/ /g, '');
const P = new Set(POS.map(J)), N = new Set(NEG.map(J));
const PH = [...POS, ...NEG].filter((w) => w.includes(' '));
const PESTS = /chuột|gián/i;
const DANGER = / (mat do|trom|con chuot|con gian|ngo doc|chay no|giat dien|an ninh|khieu nai|con trung|khong co nuoc) /;
const clean = (c) => c.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function sent(c) {
  for (const w of PH) c = c.split(w).join(J(w));
  const t = c.split(' ');
  let s = 0;
  t.forEach((w, i) => {
    let v = P.has(w) ? 1 : N.has(w) ? -1 : 0;
    if (w === 'love' && t[i + 1] === 'cau') v = 0;
    if (v && /^(khong|chua|chang|ko)$/.test(t[i - 1] || '')) v = -v;
    s += v;
  });
  return s;
}

function rules(text) {
  const clauses = norm(text).split(/[.!?\n;,]+|\bnhung\b/).map(clean).filter(Boolean);
  let tot = 0;
  const aspects = {};
  for (const c of clauses) {
    const s = sent(c), pc = ' ' + c + ' ';
    tot += s;
    for (const [k, ws] of Object.entries(KW)) {
      if (ws.split(',').some((w) => pc.includes(' ' + w + ' ')))
        aspects[k] = s < 0 || aspects[k] === 'negative' ? 'negative' : s > 0 ? 'positive' : aspects[k] || 'neutral';
    }
  }
  const normalized = ' ' + clean(norm(text)) + ' ';
  const pests = PESTS.test(text) || / chuot /.test(normalized);
  const danger = pests || DANGER.test(normalized);
  if (pests) aspects.cleanliness = 'negative';
  const score = tot / (Math.abs(tot) + 1.5);
  return { score, aspects, danger, urgency: danger ? 'high' : score < -0.3 ? 'medium' : 'low', summary: text.slice(0, 90) };
}

// ---------- Phân tích bằng AI (Workers AI, Llama 3.1 8B) ----------
const SYS = `You analyze hotel guest reviews written in Vietnamese or English. Reply with ONLY one JSON object, no other text:
{"sentiment":"positive|neutral|negative","score":<number -1..1>,"aspects":{"<aspect>":"positive|neutral|negative"},"urgency":"low|medium|high","summary":"<max 20 words, in Vietnamese>"}
Allowed aspect keys: cleanliness, staff, food, facilities, location, price, checkin, noise. Only include aspects the guest actually mentions.
urgency=high only for safety, hygiene hazards, theft, pests, harassment or very serious complaints.`;

async function ai(env, text, rating) {
  const r = await env.AI.run(MODEL, {
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: `Rating: ${rating}/5\nReview: ${text}` }],
    max_tokens: 300, temperature: 0.1,
  });
  const raw = typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
  const j = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  const ok = (v) => ['positive', 'neutral', 'negative'].includes(v);
  if (!ok(j.sentiment) || typeof j.score !== 'number') throw new Error('bad ai output');
  const aspects = {};
  for (const [k, v] of Object.entries(j.aspects || {})) if (CATS.includes(k) && ok(v)) aspects[k] = v;
  return { score: clamp(j.score), aspects, urgency: ['low', 'medium', 'high'].includes(j.urgency) ? j.urgency : 'low', summary: String(j.summary || '').slice(0, 160) };
}

async function analyze(env, text, rating, useAI = true) {
  const r = rules(text);
  let a = null;
  if (useAI && env.AI) { try { a = await ai(env, text, rating); } catch (e) { console.log('AI fallback:', e.message); } }
  const source = a ? 'ai' : 'rules';
  a = a || r;
  const score = clamp(0.75 * a.score + 0.25 * (rating - 3) / 2); // kết hợp văn bản + số sao
  const aspects = { ...r.aspects, ...a.aspects };
  for (const [k, v] of Object.entries(r.aspects))
    if (v !== 'neutral') aspects[k] = v;
  return {
    sentiment: score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral',
    score: +score.toFixed(2),
    aspects,
    urgency: r.danger ? 'high' : a.urgency,
    summary: a.summary || text.slice(0, 90),
    source,
  };
}

async function suggest(env, f) {
  if (!env.AI) throw new Error('Workers AI chưa được cấu hình.');
  const r = await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: 'Bạn là quản lý chăm sóc khách hàng của khách sạn. Soạn phản hồi bằng tiếng Việt tự nhiên, lịch sự, khoảng 70-100 từ. Cá nhân hóa bằng cách nhắc đúng ít nhất một chi tiết cụ thể khách đã nêu; không dùng câu trả lời khuôn mẫu chung chung và không chép nguyên văn đánh giá. Với đánh giá chưa tốt, xin lỗi phù hợp và đề xuất bước xử lý dựa trên nội dung, không khẳng định việc gì đã được thực hiện. Với đánh giá tốt, cảm ơn về trải nghiệm cụ thể. Không bịa thông tin, ưu đãi, chi phí hay cam kết. Chỉ trả về nội dung thư.' },
      { role: 'user', content: `Tên khách: ${f.guest_name}\nĐiểm đánh giá: ${f.rating}/5\nNội dung khách chia sẻ:\n${f.comment}` },
    ],
    max_tokens: 300,
    temperature: 0.7,
  });
  const reply = typeof r.response === 'string' ? r.response.trim() : '';
  if (!reply) throw new Error('Workers AI trả về nội dung trống.');
  return reply;
}

// ---------- Database ----------
const insert = (env, n, room, rating, comment, a, offset = '0 days') =>
  env.DB.prepare("INSERT INTO feedbacks(guest_name,room,rating,comment,sentiment,score,aspects,urgency,summary,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now',?))")
    .bind(n, room, rating, comment, a.sentiment, a.score, JSON.stringify(a.aspects), a.urgency, a.summary, a.source, offset).run();
const insertStatement = (env, n, room, rating, comment, a) =>
  env.DB.prepare("INSERT INTO feedbacks(guest_name,room,rating,comment,sentiment,score,aspects,urgency,summary,source) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(n, room, rating, comment, a.sentiment, a.score, JSON.stringify(a.aspects), a.urgency, a.summary, a.source);
const makeAccessToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
const hashAccessToken = async (token) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

const SEED = [
  [5, 'Linh', '305', 'Phòng sạch sẽ, nhân viên lễ tân rất thân thiện và nhiệt tình. Bữa sáng ngon, vị trí gần biển.'],
  [2, 'Hùng', '212', 'Phòng tắm có mùi hôi, điều hòa kêu to. Nhân viên xử lý chậm, tôi rất thất vọng.'],
  [4, 'Mai', '118', 'Hồ bơi đẹp, wifi nhanh. Giá hợp lý so với chất lượng.'],
  [1, 'Tuấn', '420', 'Phát hiện con gián trong phòng tắm, báo lễ tân nhưng chờ rất lâu mới có người xử lý.'],
  [3, 'Lan', '507', 'Thủ tục check in hơi lâu, nhưng phòng thoải mái và yên tĩnh.'],
  [5, 'Quân', '233', 'Dịch vụ tuyệt vời, nhân viên chuyên nghiệp, buffet sáng rất ngon.'],
  [2, 'Vy', '319', 'Tiếng ồn từ hành lang suốt đêm, không ngủ được. Giá thì khá đắt.'],
  [4, 'Nam', '101', 'Vị trí thuận tiện, phòng rộng rãi và sạch. Thang máy hơi chậm.'],
  [1, 'Hoa', '610', 'Wifi rất yếu, nước nóng không có, nhân viên thái độ kém. Sẽ khiếu nại.'],
  [5, 'Đạt', '402', 'Kỳ nghỉ tuyệt vời, mọi thứ đều tốt, phòng thơm và sạch.'],
];

// ---------- Router ----------
export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (p === '/api/feedback' && m === 'POST') {
        const b = await req.json().catch(() => ({}));
        const rating = +b.rating, comment = String(b.comment || '').trim().slice(0, 2000);
        if (!(rating >= 1 && rating <= 5) || comment.length < 5) return json({ error: 'Vui lòng chọn số sao và nhập ít nhất 5 ký tự.' }, 400);
        const name = String(b.name || '').trim().slice(0, 80) || 'Khách ẩn danh';
        const token = makeAccessToken(), tokenHash = await hashAccessToken(token);
        await env.DB.batch([
          insertStatement(env, name, String(b.room || '').trim().slice(0, 10), Math.round(rating), comment, await analyze(env, comment, rating)),
          env.DB.prepare('INSERT INTO feedback_access(feedback_id, token_hash) VALUES(last_insert_rowid(), ?)').bind(tokenHash),
        ]);
        return json({ ok: true, token });
      }
      if (p === '/api/feedback/lookup' && m === 'POST') {
        const b = await req.json().catch(() => ({}));
        const token = String(b.token || '').trim().toLowerCase();
        if (!/^[a-f0-9]{48}$/.test(token)) return json({ error: 'Mã tra cứu không hợp lệ.' }, 400);
        const f = await env.DB.prepare('SELECT f.status, f.reply FROM feedback_access a JOIN feedbacks f ON f.id=a.feedback_id WHERE a.token_hash=?')
          .bind(await hashAccessToken(token)).first();
        return f
          ? json({ status: f.status, reply: f.status === 'resolved' ? f.reply : '' })
          : json({ error: 'Không tìm thấy đánh giá với mã tra cứu này.' }, 404);
      }
      if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);

      if (p === '/api/stats' && m === 'GET') {
        const [t, rt, tr, as] = await env.DB.batch([
          env.DB.prepare("SELECT COUNT(*) total, AVG(rating) avg, SUM(sentiment='positive') positive, SUM(sentiment='neutral') neutral, SUM(sentiment='negative') negative, SUM(urgency='high' AND status!='resolved') urgent FROM feedbacks"),
          env.DB.prepare('SELECT rating, COUNT(*) n FROM feedbacks GROUP BY rating'),
          env.DB.prepare('SELECT d, a, n FROM (SELECT date(created_at) d, AVG(rating) a, COUNT(*) n FROM feedbacks GROUP BY d ORDER BY d DESC LIMIT 14) ORDER BY d'),
          env.DB.prepare('SELECT aspects FROM feedbacks ORDER BY id DESC LIMIT 1000'),
        ]);
        const x = t.results[0], aspects = {};
        for (const r of as.results) for (const [k, v] of Object.entries(JSON.parse(r.aspects || '{}'))) {
          aspects[k] ||= { positive: 0, neutral: 0, negative: 0 };
          aspects[k][v]++;
        }
        const ratings = {};
        rt.results.forEach((r) => (ratings[r.rating] = r.n));
        return json({ total: x.total, avg: x.avg || 0, urgent: x.urgent || 0, sent: { positive: x.positive || 0, neutral: x.neutral || 0, negative: x.negative || 0 }, ratings, aspects, trend: tr.results });
      }
      if (p === '/api/feedbacks' && m === 'GET') {
        const w = [], a = [];
        for (const k of ['sentiment', 'status']) { const v = u.searchParams.get(k); if (v) { w.push(k + '=?'); a.push(v); } }
        const { results } = await env.DB.prepare(`SELECT * FROM feedbacks ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`).bind(...a).all();
        return json({ items: results });
      }
      if (p === '/api/feedbacks' && m === 'DELETE') {
        const b = await req.json().catch(() => ({}));
        if (b.all === true) {
          const [, deleted] = await env.DB.batch([
            env.DB.prepare('DELETE FROM feedback_access'),
            env.DB.prepare('DELETE FROM feedbacks'),
          ]);
          return json({ ok: true, deleted: deleted.meta.changes || 0 });
        }
        const ids = Array.isArray(b.ids) ? [...new Set(b.ids)] : [];
        if (!ids.length || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
          return json({ error: 'Hãy chọn từ 1 đến 100 đánh giá hợp lệ để xóa.' }, 400);
        const placeholders = ids.map(() => '?').join(',');
        const [, deleted] = await env.DB.batch([
          env.DB.prepare(`DELETE FROM feedback_access WHERE feedback_id IN (${placeholders})`).bind(...ids),
          env.DB.prepare(`DELETE FROM feedbacks WHERE id IN (${placeholders})`).bind(...ids),
        ]);
        return json({ ok: true, deleted: deleted.meta.changes || 0 });
      }
      if (p === '/api/seed' && m === 'POST') {
        for (const [i, [rating, name, room, comment]] of SEED.entries())
          await insert(env, name, room, rating, comment, await analyze(env, comment, rating, false), `-${i % 9} days`);
        return json({ ok: true });
      }
      const mm = p.match(/^\/api\/feedbacks\/(\d+)(\/suggest)?$/);
      if (mm) {
        const id = +mm[1];
        if (mm[2] && m === 'POST') {
          const f = await env.DB.prepare('SELECT * FROM feedbacks WHERE id=?').bind(id).first();
          if (!f) return json({ error: 'not found' }, 404);
          try { return json({ reply: await suggest(env, f) }); }
          catch (e) {
            console.log('AI reply suggestion failed:', e.message);
            return json({ error: 'Không thể soạn phản hồi bằng AI lúc này. Hãy thử lại hoặc kiểm tra cấu hình Workers AI.' }, 503);
          }
        }
        if (m === 'PATCH') {
          const b = await req.json().catch(() => ({}));
          const st = ['new', 'progress', 'resolved'].includes(b.status) ? b.status : 'new';
          await env.DB.prepare('UPDATE feedbacks SET reply=?, status=? WHERE id=?').bind(String(b.reply || '').slice(0, 3000), st, id).run();
          return json({ ok: true });
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.log(e);
      return json({ error: 'Lỗi máy chủ' }, 500);
    }
  },
};
