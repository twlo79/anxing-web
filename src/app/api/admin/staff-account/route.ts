import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!process.env.SUPABASE_SERVICE_KEY)
    return NextResponse.json({ error: 'no service key' }, { status: 500 });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 驗證呼叫者為 super_admin
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
  const { data: userData } = await admin.auth.getUser(token);
  const caller = userData?.user;
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: prof } = await admin.from('profiles').select('role').eq('id', caller.id).single();
  if (prof?.role !== 'super_admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = await req.json();
  const { action, staffId } = body;
  const { data: st } = await admin.from('staff').select('*').eq('id', staffId).single();
  if (!st) return NextResponse.json({ error: 'staff not found' }, { status: 404 });

  if (action === 'create') {
    const { email, password, role } = body;
    if (!email || !password) return NextResponse.json({ error: '需要 email 與密碼' }, { status: 400 });
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created?.user) return NextResponse.json({ error: error?.message || '建立失敗' }, { status: 400 });
    const uid = created.user.id;
    await admin.from('profiles').upsert({ id: uid, role: role || 'housekeeper', name: st.name });
    await admin.from('staff').update({ email, auth_uid: uid, role: role || 'housekeeper' }).eq('id', staffId);
    return NextResponse.json({ ok: true });
  }

  if (action === 'password') {
    if (!st.auth_uid) return NextResponse.json({ error: '此人員尚無帳號' }, { status: 400 });
    const { password } = body;
    if (!password) return NextResponse.json({ error: '需要密碼' }, { status: 400 });
    const { error } = await admin.auth.admin.updateUserById(st.auth_uid, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === 'role') {
    const { role } = body;
    await admin.from('staff').update({ role }).eq('id', staffId);
    if (st.auth_uid) await admin.from('profiles').update({ role }).eq('id', st.auth_uid);
    return NextResponse.json({ ok: true });
  }

  if (action === 'ban') {
    if (!st.auth_uid) return NextResponse.json({ ok: true, note: '無帳號,略過' });
    const { ban } = body;
    const { error } = await admin.auth.admin.updateUserById(st.auth_uid, { ban_duration: ban ? '876000h' : 'none' });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === 'delete_account') {
    if (!st.auth_uid) return NextResponse.json({ ok: true });
    await admin.auth.admin.deleteUser(st.auth_uid);
    await admin.from('staff').update({ auth_uid: null, email: null }).eq('id', staffId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
