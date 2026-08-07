/* eslint-disable i18next/no-literal-string */
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import axios from '../api/axios.js';
import { Mail, ArrowLeft, AlertCircle, CheckCircle, Layers } from 'lucide-react';
import toast from 'react-hot-toast';

const schema = z.object({
  email: z.string().email('Please enter a valid email address')
});

export const ForgotPasswordPage = () => {
  const [success, setSuccess] = useState(false);
  const [serverError, setServerError] = useState('');

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema)
  });

  const onSubmit = async (data) => {
    setServerError('');
    try {
      await axios.post('/api/v1/auth/forgot-password', { email: data.email });
      setSuccess(true);
      toast.success('Reset link dispatched.');
    } catch (err) {
      setServerError(err.response?.data?.error || 'Failed to dispatch reset request.');
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #faf7f2 0%, #f0e8dc 50%, #e8ddd0 100%)' }}>

      {/* Decorative blobs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full opacity-30"
          style={{ background: 'radial-gradient(circle, #e8a87c 0%, transparent 70%)' }} />
        <div className="absolute -bottom-40 -left-24 w-80 h-80 rounded-full opacity-20"
          style={{ background: 'radial-gradient(circle, #c8956c 0%, transparent 70%)' }} />
      </div>

      <div className="relative w-full max-w-md">
        {/* Card */}
        <div className="rounded-2xl p-8 shadow-xl border"
          style={{ background: 'rgba(255,255,255,0.90)', backdropFilter: 'blur(20px)', borderColor: 'rgba(200,149,108,0.20)' }}>

          {/* Logo mark */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 shadow-md"
              style={{ background: 'linear-gradient(135deg, #c8956c 0%, #e8a87c 100%)' }}>
              <Layers size={26} className="text-white" />
            </div>
            <h1 className="text-2xl font-black tracking-tight text-center" style={{ color: '#2d2520' }}>Reset Password</h1>
            <p className="text-xs uppercase tracking-widest mt-1 text-center" style={{ color: '#b5a898' }}>Request a recovery link</p>
          </div>

          {serverError && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl mb-5 border"
              style={{ background: 'rgba(192,57,43,0.07)', borderColor: 'rgba(192,57,43,0.25)', color: '#c0392b' }}>
              <AlertCircle size={14} />
              <span>{serverError}</span>
            </div>
          )}

          {success ? (
            <div className="text-center space-y-4">
              <div className="flex justify-center text-[#2ecc71]">
                <CheckCircle size={48} className="animate-bounce" />
              </div>
              <p className="text-sm" style={{ color: '#7a6a5a' }}>
                If that account exists, we have dispatched a password reset link to your email address.
              </p>
              <div className="pt-4">
                <Link to="/login" className="text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                  style={{ color: 'var(--accent)' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
                  <ArrowLeft size={14} /> Back to Sign In
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold uppercase tracking-wide" style={{ color: '#7a6a5a' }}>Email Address</label>
                <input
                  type="email"
                  className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                  placeholder="e.g. adminofleads@gmail.com"
                  {...register('email')}
                  disabled={isSubmitting}
                />
                {errors.email && (
                  <span className="text-xs font-semibold" style={{ color: '#c0392b' }}>{errors.email.message}</span>
                )}
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full mt-4 bg-[--accent] text-white font-black uppercase py-2.5 rounded-lg hover:bg-[--accent-hover] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #c8956c 0%, #e8a87c 100%)', boxShadow: '0 4px 14px rgba(200,149,108,0.40)' }}
              >
                {isSubmitting ? (
                  <div className="spinner" style={{ width: '18px', height: '18px', borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.3)' }} />
                ) : (
                  <>
                    <Mail size={16} />
                    <span>Send Reset Link</span>
                  </>
                )}
              </button>

              <div className="text-center pt-4">
                <Link to="/login" className="text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                  style={{ color: 'var(--accent)' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
                  <ArrowLeft size={14} /> Back to Sign In
                </Link>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-xs mt-6" style={{ color: '#b5a898' }}>
          LeadsBase CRM &copy; {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;
