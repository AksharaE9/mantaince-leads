import React, { useState, useEffect } from 'react';
import axios from '../api/axios.js';
import { useAuthStore } from '../store/authStore.js';
import { 
  Users, UserPlus, Shield, Check, X, ShieldCheck, Mail, Key, Trash2, 
  ChevronRight, AlertTriangle, AlertCircle, RefreshCw, Briefcase,
  Eye, EyeOff
} from 'lucide-react';
import toast from 'react-hot-toast';
export const AdminUsersPage = () => {
  const { user: currentAdmin } = useAuthStore();
  const [users, setUsers] = useState([]);
  const [verticals, setVerticals] = useState([]);
  const [loading, setLoading] = useState(true);

  // Selected user for slide-over drawer
  const [selectedUser, setSelectedUser] = useState(null);
  
  // Drawer edit states
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [selectedVerticalIds, setSelectedVerticalIds] = useState([]);
  const [savingUser, setSavingUser] = useState(false);

  // Invite Modal states
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [invitePassword, setInvitePassword] = useState('TempPassword123!');
  const [inviteVerticals, setInviteVerticals] = useState([]);
  const [inviting, setInviting] = useState(false);

  // Sensitive Role Confirmation Modal
  const [showConfirmRoleModal, setShowConfirmRoleModal] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingRole, setPendingRole] = useState('');

  // Set Password Modal State
  const [showSetPasswordModal, setShowSetPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [newConfirmPassword, setNewConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);

  const fetchUsersAndVerticals = async () => {
    setLoading(true);
    try {
      const [usersRes] = await Promise.all([
        axios.get('/api/v1/users')
      ]);
      setUsers(usersRes.data.data);
    } catch (err) {
      toast.error('Failed to retrieve user listing');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsersAndVerticals();
  }, []);

  const handleApproveUser = async (userId, e) => {
    e.stopPropagation();
    try {
      await axios.patch(`/api/v1/users/${userId}/approve`);
      toast.success('User approved successfully!');
      await fetchUsersAndVerticals();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve user');
    }
  };

  const handleSelectUser = (user) => {
    setSelectedUser(user);
    setEditName(user.name);
    setEditEmail(user.email);
    setEditRole(user.roleId?.name || 'agent');
    setEditActive(user.is_active);
    setSelectedVerticalIds(user.vertical_access?.map(v => v.id || v) || []);
  };

  const handleToggleVertical = (verticalId) => {
    if (selectedVerticalIds.includes(verticalId)) {
      setSelectedVerticalIds(selectedVerticalIds.filter(id => id !== verticalId));
    } else {
      setSelectedVerticalIds([...selectedVerticalIds, verticalId]);
    }
  };

  const handleSaveGeneralDetails = async () => {
    if (!selectedUser) return;
    setSavingUser(true);
    try {
      // Update basic info (name, email, isActive)
      await axios.patch(`/api/v1/users/${selectedUser.id}`, {
        name: editName,
        email: editEmail,
        isActive: editActive
      });

      toast.success('User details updated successfully');
      await fetchUsersAndVerticals();
      setSelectedUser(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update user profile details');
    } finally {
      setSavingUser(false);
    }
  };

  // Change Role handles the sensitive modal launch
  const handleRoleChangeSelect = (newRole) => {
    const currentRole = selectedUser.role_name;
    if (newRole !== currentRole) {
      setPendingRole(newRole);
      setShowConfirmRoleModal(true);
    }
  };

  const handleConfirmRoleChange = async () => {
    if (!selectedUser || !pendingRole) return;
    setSavingUser(true);
    try {
      await axios.patch(`/api/v1/users/${selectedUser.id}/role`, {
        role: pendingRole,
        adminPassword: confirmPassword
      });
      toast.success(`Role changed to ${pendingRole} successfully`);
      setShowConfirmRoleModal(false);
      setConfirmPassword('');
      await fetchUsersAndVerticals();
      setSelectedUser(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to authorize role transition');
    } finally {
      setSavingUser(false);
    }
  };

  const handleOpenSetPasswordModal = () => {
    setNewPassword('');
    setNewConfirmPassword('');
    setShowNewPassword(false);
    setShowSetPasswordModal(true);
  };

  const handleSetPasswordSubmit = async (e) => {
    e.preventDefault();
    if (!selectedUser) return;
    if (newPassword !== newConfirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters long');
      return;
    }

    setSettingPassword(true);
    try {
      await axios.post(`/api/v1/admin/users/${selectedUser.id}/set-password`, {
        password: newPassword,
        confirmPassword: newConfirmPassword
      });
      toast.success(`Password for ${selectedUser.name} updated successfully!`);
      setShowSetPasswordModal(false);
      setNewPassword('');
      setNewConfirmPassword('');
      setShowNewPassword(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update user password');
    } finally {
      setSettingPassword(false);
    }
  };

  const handleDeactivate = async () => {
    if (!selectedUser) return;
    if (window.confirm(`Are you sure you want to deactivate ${selectedUser.name}?`)) {
      try {
        await axios.delete(`/api/v1/users/${selectedUser.id}`);
        toast.success('User deactivated successfully');
        await fetchUsersAndVerticals();
        setSelectedUser(null);
      } catch (err) {
        toast.error(err.response?.data?.error || 'Failed to deactivate user account');
      }
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) return;
    if (window.confirm(`Are you sure you want to permanently delete ${selectedUser.name}? This action cannot be undone.`)) {
      try {
        await axios.delete(`/api/v1/users/${selectedUser.id}?hard=true`);
        toast.success('User deleted permanently');
        await fetchUsersAndVerticals();
        setSelectedUser(null);
      } catch (err) {
        toast.error(err.response?.data?.error || 'Failed to delete user account');
      }
    }
  };

  const handleInviteSubmit = async (e) => {
    e.preventDefault();
    setInviting(true);
    try {
      await axios.post('/api/v1/users/invite', {
        name: inviteName,
        email: inviteEmail,
        role: inviteRole,
        password: invitePassword
      });
      toast.success('User invited and created successfully!');
      setShowInviteModal(false);
      // Reset form
      setInviteName('');
      setInviteEmail('');
      setInviteRole('agent');
      setInvitePassword('TempPassword123!');
      setInviteVerticals([]);
      await fetchUsersAndVerticals();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invitation mapping failed');
    } finally {
      setInviting(false);
    }
  };

  const getRoleBadgeStyle = (roleName) => {
    switch (roleName) {
      case 'super_admin': return 'bg-red-50 text-red-700 border-red-200';
      case 'vertical_admin': return 'bg-[--accent-light] text-[--accent] border-[--accent-border]';
      default: return 'bg-stone-100 text-[--text-secondary] border-stone-200';
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider">User Accounts</h2>
          <p className="text-xs text-[--text-secondary] mt-1">Manage tenant operators access privileges, system roles, and workspace memberships</p>
        </div>
        <button
          onClick={() => setShowInviteModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[--accent] text-white font-black uppercase text-xs rounded-lg hover:bg-[--accent-hover] transition-all shadow-md"
        >
          <UserPlus size={14} />
          <span>Invite Operator</span>
        </button>
      </div>

      {/* Main split dashboard view */}
      <div className="flex flex-col lg:flex-row gap-6">
        
        {/* Left side: Users table */}
        <div className="flex-1 glass-panel bg-white shadow-sm border border-[--border] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-[--border-strong] bg-stone-50 text-xs font-bold text-[--text-secondary] uppercase select-none tracking-wider">
                  <th className="px-6 py-4">Name</th>
                  <th className="px-6 py-4">Email</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4">Approval</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--border]">
                {loading ? (
                  Array.from({ length: 4 }).map((_, idx) => (
                    <tr key={idx} className="animate-pulse">
                      <td className="px-6 py-4"><div className="h-4 bg-stone-100 rounded w-24"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-stone-100 rounded w-36"></div></td>
                      <td className="px-6 py-4"><div className="h-5 bg-stone-100 rounded w-16"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-stone-100 rounded w-32"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-stone-100 rounded w-12"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-stone-100 rounded w-10 ml-auto"></div></td>
                    </tr>
                  ))
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="text-center py-12 text-[--text-secondary] text-xs">
                      No user accounts found. Click Invite to create.
                    </td>
                  </tr>
                ) : (
                  users.map(user => (
                    <tr 
                      key={user.id} 
                      onClick={() => handleSelectUser(user)}
                      className={`hover:bg-stone-50/50 cursor-pointer transition-all ${
                        selectedUser?.id === user.id ? 'bg-[--accent-light]' : ''
                      }`}
                    >
                      <td className="px-6 py-4 text-[--text-primary] font-semibold">
                        {user.name}
                      </td>
                      <td className="px-6 py-4 text-xs font-mono text-[--text-secondary]">
                        {user.email}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-block px-2.5 py-0.5 text-[9px] font-mono font-bold uppercase border rounded-md ${getRoleBadgeStyle(user.role_name)}`}>
                          {user.role_name?.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {user.is_approved ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase rounded-full bg-green-50 text-green-700 border border-green-200">
                            <Check size={9} /> Approved
                          </span>
                        ) : (
                          <button
                            onClick={(e) => handleApproveUser(user.id, e)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase rounded-full bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all cursor-pointer"
                          >
                            <AlertTriangle size={9} /> Pending — Approve
                          </button>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-block w-2 h-2 rounded-full ${user.is_active ? 'bg-[#2ecc71]' : 'bg-red-500'}`} />
                        <span className="text-xs ml-1.5 font-semibold text-[--text-primary]">{user.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleSelectUser(user); }}
                            className="p-1.5 text-[--text-muted] hover:text-[--text-primary] hover:bg-stone-100 rounded transition-all"
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right side: Slide-over details editor drawer (appears on selection) */}
        {selectedUser && (
          <div className="w-full lg:w-96 glass-panel bg-white border border-[--border] shadow-sm p-6 space-y-6 flex flex-col justify-between">
            <div className="space-y-6">
              
              {/* Drawer header */}
              <div className="flex items-center justify-between border-b border-[--border] pb-4">
                <div>
                  <h3 className="text-sm font-bold text-[--text-primary] uppercase tracking-wider">Manage Account</h3>
                  <p className="text-xs text-[--text-secondary] font-mono mt-0.5">{selectedUser.email}</p>
                </div>
                <button 
                  onClick={() => setSelectedUser(null)}
                  className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:bg-stone-50 transition-all"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Editable Fields Form */}
              <div className="space-y-4 text-xs">
                
                {/* 1. Name input */}
                <div className="flex flex-col gap-1.5">
                  <label className="font-bold text-[--text-secondary] uppercase">Display Name</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                  />
                </div>

                {/* 2. Email input */}
                <div className="flex flex-col gap-1.5">
                  <label className="font-bold text-[--text-secondary] uppercase">Email Address</label>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                  />
                </div>

                {/* 3. Role input */}
                <div className="flex flex-col gap-1.5">
                  <label className="font-bold text-[--text-secondary] uppercase">System Access Privilege Role</label>
                  <select
                    value={editRole}
                    onChange={(e) => handleRoleChangeSelect(e.target.value)}
                    className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                  >
                    <option value="agent">Agent (Operator)</option>
                    <option value="vertical_admin">Vertical Admin</option>
                    <option value="super_admin">Super Administrator</option>
                  </select>
                </div>

                {/* 4. Active switch toggle */}
                <div className="flex items-center justify-between bg-stone-50/50 p-3 rounded-lg border border-[--border]">
                  <div>
                    <span className="font-bold text-[--text-primary] uppercase block">Account Status</span>
                    <span className="text-[10px] text-[--text-secondary] block mt-0.5">Toggle active login status</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={editActive}
                    onChange={(e) => setEditActive(e.target.checked)}
                    className="w-8 h-4 rounded-full bg-stone-200 border border-stone-300 appearance-none checked:bg-[#2ecc71] relative cursor-pointer outline-none transition-all after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-3 after:h-3 after:bg-white after:rounded-full after:transition-all checked:after:left-4.5"
                  />
                </div>


              </div>
            </div>

            {/* Bottom Actions */}
            <div className="space-y-2 pt-4 border-t border-[--border]">
              <button
                onClick={handleSaveGeneralDetails}
                disabled={savingUser}
                className="w-full py-2 bg-[--accent] text-white font-black uppercase text-xs rounded-lg hover:bg-[--accent-hover] transition-all flex items-center justify-center gap-1.5 shadow-sm"
              >
                {savingUser ? <RefreshCw className="animate-spin" size={12} /> : <Check size={12} />}
                <span>Save Changes</span>
              </button>

              <button
                onClick={handleOpenSetPasswordModal}
                className="w-full py-2 border border-[--border-strong] hover:bg-stone-50 text-[--text-secondary] font-semibold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5"
              >
                <Key size={12} />
                <span>Set Password</span>
              </button>

              <button
                onClick={handleDeactivate}
                className="w-full py-2 bg-red-50 border border-red-200 hover:bg-red-100/50 text-red-600 font-semibold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5"
              >
                <Trash2 size={12} />
                <span>Deactivate Operator</span>
              </button>

              <button
                onClick={handleDeleteUser}
                className="w-full py-2 bg-red-600 hover:bg-red-700 text-white font-semibold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm"
              >
                <Trash2 size={12} />
                <span>Delete Operator</span>
              </button>
            </div>

          </div>
        )}



      </div>

      {/* Invite User Dialog Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-md bg-white border border-[--border] shadow-xl p-6 space-y-4">
            
            <div className="flex justify-between items-center border-b border-[--border] pb-3">
              <h3 className="text-md font-bold text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
                <UserPlus className="text-[--accent]" size={18} />
                <span>Invite New Operator</span>
              </h3>
              <button 
                onClick={() => setShowInviteModal(false)}
                className="text-[--text-secondary] hover:text-[--text-primary]"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleInviteSubmit} className="space-y-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Full Name</label>
                <input
                  type="text"
                  required
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                  placeholder="e.g. Rahul Sharma"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Email Address</label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                  placeholder="e.g. rahul@leadsbase.io"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Temporary Login Password</label>
                <input
                  type="text"
                  required
                  value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent] font-mono text-xs"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Role Privilege Mapping</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                >
                  <option value="agent">Agent (Operator)</option>
                  <option value="vertical_admin">Vertical Administrator</option>
                  <option value="super_admin">Super Administrator</option>
                </select>
              </div>



              <div className="flex justify-end gap-3 pt-3 border-t border-[--border]">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="px-4 py-2 border border-[--border-strong] rounded-lg text-[--text-secondary] hover:bg-stone-50 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="px-4 py-2 bg-[--accent] text-white font-black uppercase rounded-lg hover:bg-[--accent-hover] shadow-sm"
                >
                  {inviting ? 'Inviting...' : 'Send Invitation'}
                </button>
              </div>
            </form>

          </div>
        </div>
      )}

      {/* Sensitive Role Change Password Confirmation Modal */}
      {showConfirmRoleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-sm bg-white border border-[--border] p-6 space-y-4 text-center shadow-xl">
            <div className="flex justify-center text-red-500 animate-bounce">
              <ShieldCheck size={48} />
            </div>
            <div>
              <h3 className="text-md font-bold text-[--text-primary] uppercase">Sensitive Action Authorization</h3>
              <p className="text-xs text-[--text-secondary] mt-1.5 leading-relaxed">
                Confirm password to change this user's privilege mapping to <strong>{pendingRole}</strong>.
              </p>
            </div>

            <div className="flex flex-col gap-1.5 text-left text-xs">
              <label className="font-bold text-[--text-secondary] uppercase">Admin Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-red-500 font-mono"
                placeholder="Enter your admin password"
              />
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <button
                type="button"
                onClick={() => { setShowConfirmRoleModal(false); setConfirmPassword(''); }}
                className="px-4 py-2 border border-[--border-strong] hover:bg-stone-50 text-xs text-[--text-secondary] font-semibold rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRoleChange}
                className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 shadow-sm"
              >
                Confirm Alteration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Set Password Modal */}
      {showSetPasswordModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-md bg-white border border-[--border] shadow-xl p-6 space-y-4">
            
            <div className="flex justify-between items-center border-b border-[--border] pb-3">
              <h3 className="text-md font-bold text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
                <Key className="text-[--accent]" size={18} />
                <span>Set Password</span>
              </h3>
              <button 
                onClick={() => setShowSetPasswordModal(false)}
                className="text-[--text-secondary] hover:text-[--text-primary]"
              >
                <X size={18} />
              </button>
            </div>

            <div className="bg-stone-50 p-3 rounded-lg border border-[--border] text-xs space-y-1">
              <span className="font-bold text-[--text-secondary] block uppercase">Target Account</span>
              <div className="text-[--text-primary] font-semibold text-sm">{selectedUser.name}</div>
              <div className="text-[--text-secondary] font-mono">{selectedUser.email}</div>
            </div>

            <form onSubmit={handleSetPasswordSubmit} className="space-y-4 text-xs">
              <div className="flex flex-col gap-1.5 relative">
                <label className="font-bold text-[--text-secondary] uppercase">New Password</label>
                <div className="relative">
                  <input
                    type={showNewPassword ? "text" : "password"}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg pl-3 pr-10 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent] font-mono"
                    placeholder="Enter new password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-3 top-2.5 text-[--text-muted] hover:text-[--text-primary]"
                  >
                    {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Confirm Password</label>
                <input
                  type={showNewPassword ? "text" : "password"}
                  required
                  value={newConfirmPassword}
                  onChange={(e) => setNewConfirmPassword(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent] font-mono"
                  placeholder="Confirm new password"
                />
              </div>

              {/* Password strength & matching feedback */}
              <div className="space-y-1 bg-amber-50/50 p-3 rounded-lg border border-amber-100 text-[11px] text-amber-800">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${newPassword.length >= 8 ? 'bg-[#2ecc71]' : 'bg-red-500'}`} />
                  <span>At least 8 characters long</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${newPassword && newPassword === newConfirmPassword ? 'bg-[#2ecc71]' : 'bg-red-500'}`} />
                  <span>Passwords match</span>
                </div>
              </div>

              <div className="flex items-start gap-2 bg-red-50 p-3 rounded-lg border border-red-100 text-[11px] text-red-800 leading-normal">
                <AlertCircle size={14} className="shrink-0 text-red-600 mt-0.5" />
                <span>
                  <strong>Warning:</strong> This will immediately change the password for {selectedUser.name} and sign them out of all devices.
                </span>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-[--border]">
                <button
                  type="button"
                  onClick={() => setShowSetPasswordModal(false)}
                  className="px-4 py-2 border border-[--border-strong] rounded-lg text-[--text-secondary] hover:bg-stone-50 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={settingPassword || newPassword.length < 8 || newPassword !== newConfirmPassword}
                  className="px-4 py-2 bg-[--accent] text-white font-black uppercase rounded-lg hover:bg-[--accent-hover] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {settingPassword ? 'Updating...' : 'Set Password'}
                </button>
              </div>
            </form>

          </div>
        </div>
      )}

    </div>
  );
};

export default AdminUsersPage;
