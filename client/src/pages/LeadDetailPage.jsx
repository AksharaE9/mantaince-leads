import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { 
  ArrowLeft, Edit3, Edit, Save, X, User as UserIcon, Calendar, CheckSquare, Briefcase, 
  MapPin, Camera, Upload, CheckCircle2, PlusCircle, Clock, ClipboardList, Trash2,
  ExternalLink, MessageSquare, AlertTriangle, Settings, HelpCircle
} from 'lucide-react';
import axios from '../api/axios.js';
import StatusBadge from '../components/StatusBadge.jsx';
import AuditTimeline from '../components/AuditTimeline.jsx';
import toast from 'react-hot-toast';
import { useUiStore } from '../store/uiStore.js';
import { useAuthStore } from '../store/authStore.js';

const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
};

export const LeadDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { leadsRefreshTrigger } = useUiStore();
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'super_admin' || user?.role === 'vertical_admin';

  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [verticalInfo, setVerticalInfo] = useState(null);

  // Metadata dropdown lists
  const [subVerticals, setSubVerticals] = useState([]);
  const [agents, setAgents] = useState([]);
  // Sub-vertical specific custom fields and stages
  const [customFields, setCustomFields] = useState([]);
  const [stages, setStages] = useState([]);
  const [subVerticalUsers, setSubVerticalUsers] = useState([]);

  // Follow-ups state (scheduled check-in tasks)
  const [followUps, setFollowUps] = useState([]);
  const [followUpSummary, setFollowUpSummary] = useState(null);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [completingFollowUpId, setCompletingFollowUpId] = useState(null);
  const [completedNote, setCompletedNote] = useState('');
  const [editingFollowUp, setEditingFollowUp] = useState(null);

  // Interaction log state (retroactive interaction history)
  const [interactionLogs, setInteractionLogs] = useState([]);
  const [interactionCount, setInteractionCount] = useState(0);
  const [showAddInteraction, setShowAddInteraction] = useState(false);
  const [savingInteraction, setSavingInteraction] = useState(false);
  const [interactionForm, setInteractionForm] = useState({
    interactionDate: new Date().toISOString().split('T')[0],
    interactionTime: '',
    remarks: '',
    outcome: '',
    nextFollowupDate: '',
  });

  // Geotagging manual coordinate overrides
  const [capturingGps, setCapturingGps] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // React Hook Form initialization
  const { register, handleSubmit, control, reset, setValue, watch, formState: { errors, isSubmitting } } = useForm();
  
  const watchedSubVerticalId = watch('subVerticalId');

  // Load Lead details and taxonomy metadata
  const fetchLeadDetail = async (shouldResetForm = true) => {
    try {
      // 1. Fetch Lead details and follow-ups in parallel (the first level of the waterfall)
      const [leadRes, followUpsRes, summaryRes, interactionLogsRes] = await Promise.all([
        axios.get(`/api/v1/leads/${id}`),
        axios.get(`/api/v1/followUps/leads/${id}/follow-ups`),
        axios.get(`/api/v1/followUps/leads/${id}/follow-ups/summary`),
        axios.get(`/api/v1/interactionLogs/leads/${id}/interaction-logs`),
      ]);
      
      const leadData = leadRes.data.data;
      setLead(leadData);
      setFollowUps(followUpsRes.data.data || []);
      setFollowUpSummary(summaryRes.data.data || null);
      const logs = interactionLogsRes.data.data || [];
      setInteractionLogs(logs);
      setInteractionCount(logs.length);
      
      // 2. Fetch all dropdowns, custom fields, stages, and sub-vertical users in a single parallel block
      const subId = leadData.sub_vertical_id;
      const [vertRes, subsRes, usersRes, fieldsRes, stagesRes, subUsersRes] = await Promise.all([
        axios.get(`/api/v1/verticals/${leadData.vertical_id}`),
        axios.get(`/api/v1/verticals/${leadData.vertical_id}/sub-verticals`),
        isAdmin ? axios.get('/api/v1/users') : Promise.resolve({ data: { data: [] } }),
        subId ? axios.get(`/api/v1/admin/sub-verticals/${subId}/custom-fields`) : Promise.resolve({ data: { data: [] } }),
        subId ? axios.get(`/api/v1/admin/sub-verticals/${subId}/stages`) : Promise.resolve({ data: { data: [] } }),
        subId ? axios.get(`/api/v1/admin/sub-verticals/${subId}/users`) : Promise.resolve({ data: { data: [] } })
      ]);

      setVerticalInfo(vertRes.data.data);
      setSubVerticals(subsRes.data.data.filter(s => s.isActive));
      setAgents(usersRes.data.data.filter(u => u.is_active && (u.role_name === 'agent' || u.role_name === 'vertical_admin')));

      if (subId) {
        setCustomFields((fieldsRes.data.data || []).filter(f => f.is_active !== false));
        setStages(stagesRes.data.data);
        setSubVerticalUsers(subUsersRes.data.data);
      } else {
        setCustomFields([]);
        setStages([]);
        setSubVerticalUsers([]);
      }

      if (shouldResetForm) {
        // Prepopulate form fields
        reset({
          name: leadData.name,
          phone: leadData.phone || '',
          businessName: leadData.business_name || leadData.businessName || '',
          status: leadData.status,
          subVerticalId: leadData.sub_vertical_id || '',
          assignedTo: null,
          leadType: leadData.lead_type || 'CALL',
          stageId: leadData.stage_id || leadData.stageId || '',
          customValues: leadData.customValues || {},
          data: leadData.data || {}
        });
      }
    } catch (err) {
      console.error('Error fetching lead details:', err);
      toast.error('Failed to load lead details.');
      navigate('/leads');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchLeadDetail(true);
  }, [id]);

  useEffect(() => {
    if (leadsRefreshTrigger > 0) {
      fetchLeadDetail(false);
    }
  }, [leadsRefreshTrigger]);

  useEffect(() => {
    if (!loading && lead && window.location.hash === '#follow-ups') {
      setTimeout(() => {
        const el = document.getElementById('follow-ups-section');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
          el.classList.add('ring-2', 'ring-[--accent]', 'ring-offset-2');
          setTimeout(() => {
            el.classList.remove('ring-2', 'ring-[--accent]', 'ring-offset-2');
          }, 2000);
        }
      }, 300);
    }
  }, [loading, lead]);

  // Load custom fields/stages dynamically if sub-vertical changes in edit mode
  useEffect(() => {
    const loadSubVerticalConfigs = async () => {
      if (watchedSubVerticalId && editMode) {
        try {
          const [fieldsRes, stagesRes, subUsersRes] = await Promise.all([
            axios.get(`/api/v1/admin/sub-verticals/${watchedSubVerticalId}/custom-fields`),
            axios.get(`/api/v1/admin/sub-verticals/${watchedSubVerticalId}/stages`),
            axios.get(`/api/v1/admin/sub-verticals/${watchedSubVerticalId}/users`)
          ]);
          setCustomFields((fieldsRes.data.data || []).filter(f => f.is_active !== false));
          setStages(stagesRes.data.data);
          setSubVerticalUsers(subUsersRes.data.data);
        } catch (err) {
          console.error(err);
        }
      }
    };
    loadSubVerticalConfigs();
  }, [watchedSubVerticalId, editMode]);

  const onSubmit = async (formData) => {
    try {
      const payload = {
        name: formData.name,
        phone: formData.phone,
        businessName: formData.name, // keep name and businessName in sync
        subVerticalId: formData.subVerticalId || null,
        assignedTo: null,
        status: lead.status,
        leadType: lead.lead_type === 'POSITIVE' ? 'POSITIVE' : (formData.leadType || 'CALL'),
        stageId: formData.stageId || null,
        customValues: formData.customValues || {},
        data: {
          ...(formData.data || {}),
        }
      };

      const response = await axios.patch(`/api/v1/leads/${id}`, payload);
      setLead(response.data.data);
      setEditMode(false);
      toast.success('Lead details updated successfully.');
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update lead settings.');
    }
  };

  // Capture GPS Location
  const handleCaptureGps = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }

    setCapturingGps(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const accuracy = position.coords.accuracy;

          await axios.patch(`/api/v1/leads/${id}`, {
            geotagLat: lat,
            geotagLng: lng,
            geotagAccuracy: accuracy,
            geotagCapturedAt: new Date().toISOString()
          });

          toast.success('GPS coordinates captured successfully!');
          fetchLeadDetail(false);
        } catch (err) {
          toast.error('Failed to save GPS coordinates.');
        } finally {
          setCapturingGps(false);
        }
      },
      (error) => {
        toast.error(`Error capturing coordinates: ${error.message}`);
        setCapturingGps(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Handle photo upload + EXIF GPS extraction
  const handlePhotoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadingPhoto(true);
    try {
      // 1. Attempt to extract GPS coordinates via exifr
      let lat = null, lng = null;
      try {
        const exifrModule = await import('exifr');
        const output = await exifrModule.default.gps(file);
        if (output && output.latitude && output.longitude) {
          lat = output.latitude;
          lng = output.longitude;
          toast.success('Extracted GPS coordinates from image metadata!');
        }
      } catch (exifErr) {
        console.log('No EXIF GPS metadata found in this photo.', exifErr);
      }

      // 2. Upload file to server
      const formData = new FormData();
      formData.append('photo', file);
      const uploadRes = await axios.post(`/api/v1/leads/${id}/photo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      // 3. If EXIF had GPS coordinates, update them on the lead as well
      if (lat && lng) {
        await axios.patch(`/api/v1/leads/${id}`, {
          geotagLat: lat,
          geotagLng: lng,
          geotagCapturedAt: new Date().toISOString()
        });
      }

      toast.success('Field photo uploaded successfully.');
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to upload photo.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  // Schedule new follow-up
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleDesc, setScheduleDesc] = useState('');
  const [scheduleAgentId, setScheduleAgentId] = useState('');
  const [scheduling, setScheduling] = useState(false);

  const handleCreateFollowUp = async (e) => {
    e.preventDefault();
    if (!scheduleDate || !scheduleDesc || !scheduleAgentId) {
      toast.error('Please fill in all scheduling fields.');
      return;
    }

    setScheduling(true);
    try {
      await axios.post(`/api/v1/followUps/leads/${id}/follow-ups`, {
        assignedToId: scheduleAgentId,
        followUpDate: new Date(scheduleDate).toISOString(),
        description: scheduleDesc
      });
      toast.success('Follow-up scheduled successfully!');
      setShowScheduleForm(false);
      setScheduleDate('');
      setScheduleDesc('');
      setScheduleAgentId('');
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to schedule follow-up');
    } finally {
      setScheduling(false);
    }
  };

  const handleCompleteFollowUp = async (e, fId) => {
    e.preventDefault();
    if (!completedNote.trim()) {
      toast.error('Please write a completion note summary.');
      return;
    }

    try {
      await axios.put(`/api/v1/followUps/follow-ups/${fId}`, {
        status: 'COMPLETED',
        completedNote
      });
      toast.success('Follow-up marked completed.');
      setCompletingFollowUpId(null);
      setCompletedNote('');
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to complete follow-up');
    }
  };

  const handleUpdateFollowUpSubmit = async (e) => {
    e.preventDefault();
    if (!editingFollowUp.description?.trim()) {
      toast.error('Agenda/Description is required');
      return;
    }
    if (!editingFollowUp.follow_up_date) {
      toast.error('Date/Time is required');
      return;
    }
    try {
      await axios.put(`/api/v1/followUps/follow-ups/${editingFollowUp.id}`, {
        assignedToId: editingFollowUp.assigned_to_id || null,
        followUpDate: new Date(editingFollowUp.follow_up_date).toISOString(),
        description: editingFollowUp.description,
        status: editingFollowUp.status,
        completedNote: editingFollowUp.status === 'COMPLETED' ? (editingFollowUp.completed_note || '') : null,
      });
      toast.success('Follow-up updated successfully!');
      setEditingFollowUp(null);
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update follow-up');
    }
  };

  const handleDeleteFollowUp = async (fId) => {
    if (!window.confirm('Are you sure you want to cancel this scheduled check-in?')) return;
    try {
      await axios.delete(`/api/v1/followUps/follow-ups/${fId}`);
      toast.success('Follow-up canceled.');
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel follow-up');
    }
  };

  // ── Interaction log handlers ───────────────────────────────────────────────
  const handleCreateInteractionLog = async (e) => {
    e.preventDefault();
    if (!interactionForm.interactionDate) {
      toast.error('Interaction date is required.');
      return;
    }
    setSavingInteraction(true);
    try {
      await axios.post(`/api/v1/interactionLogs/leads/${id}/interaction-logs`, interactionForm);
      toast.success('Interaction logged successfully.');
      setShowAddInteraction(false);
      setInteractionForm({
        interactionDate: new Date().toISOString().split('T')[0],
        interactionTime: '',
        remarks: '',
        outcome: '',
        nextFollowupDate: '',
      });
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save interaction log.');
    } finally {
      setSavingInteraction(false);
    }
  };

  const handleDeleteInteractionLog = async (logId) => {
    if (!window.confirm('Delete this interaction log entry?')) return;
    try {
      await axios.delete(`/api/v1/interactionLogs/interaction-logs/${logId}`);
      toast.success('Interaction log deleted.');
      fetchLeadDetail(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete interaction log.');
    }
  };

  if (loading) {


    return (
      <div className="flex items-center justify-center py-24">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!lead) return null;

  // Allowed status transition flags checks
  const allowedTransitions = (() => {
    if (verticalInfo?.statuses && verticalInfo.statuses.length > 0) {
      return verticalInfo.statuses;
    }
    const curr = lead.status;
    if (curr === 'converted') return []; // terminal

    const base = [curr];
    if (curr === 'new') return [...base, 'contacted', 'invalid'];
    if (curr === 'contacted') return [...base, 'converted', 'lost', 'new'];
    if (curr === 'lost' || curr === 'invalid') return [...base, 'new'];
    return base;
  })();

  return (
    <div className="space-y-6">
      
      {/* Header Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => navigate(lead.lead_type === 'POSITIVE' ? '/follow-ups-positives' : '/leads')} 
            className="flex items-center gap-1.5 text-xs text-[--text-secondary] hover:text-[--accent] transition-all uppercase tracking-wider bg-transparent border-0 outline-none cursor-pointer"
          >
            <ArrowLeft size={16} />
            <span>{lead.lead_type === 'POSITIVE' ? 'Back to Positives' : 'Back to manager'}</span>
          </button>
          
          <button 
            type="button"
            onClick={() => {
              const el = document.getElementById('follow-ups-section');
              if (el) {
                el.scrollIntoView({ behavior: 'smooth' });
                el.classList.add('ring-2', 'ring-[--accent]', 'ring-offset-2');
                setTimeout(() => {
                  el.classList.remove('ring-2', 'ring-[--accent]', 'ring-offset-2');
                }, 2000);
              }
            }}
            className="flex items-center gap-1.5 text-xs text-[--accent] hover:text-[--accent-hover] transition-all uppercase tracking-wider bg-transparent border-0 outline-none cursor-pointer font-bold"
          >
            <Calendar size={14} />
            <span>Follow-up Leads</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {!editMode ? (
            <button 
              onClick={() => setEditMode(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-[--accent] text-white rounded-lg text-sm font-bold transition-all hover:bg-[--accent-hover] shadow-sm cursor-pointer"
            >
              <Edit3 size={16} />
              <span>Edit Profile</span>
            </button>
          ) : (
            <div className="flex gap-2">
              <button 
                onClick={() => { setEditMode(false); fetchLeadDetail(true); }}
                className="flex items-center gap-1.5 px-4 py-2 border border-[--border-strong] hover:bg-stone-50 rounded-lg text-sm text-[--text-secondary] font-semibold bg-white shadow-sm cursor-pointer"
              >
                <X size={16} />
                <span>Cancel</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Two Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: Form Details Card */}
        <form onSubmit={handleSubmit(onSubmit)} className="lg:col-span-2 space-y-6">
          <div className="glass-panel p-6 bg-white border border-[--border] shadow-sm space-y-6">
            <div className="flex justify-between items-start border-b border-[--border] pb-4">
              <div>
                <h1 className="text-xl font-bold text-[--text-primary]">{editMode ? 'Edit Lead Profile' : lead.name}</h1>
                <p className="text-xs text-[--text-secondary] mt-1 font-mono">ID: {lead.id}</p>
              <div className="flex items-center gap-2">
              </div>
                <StatusBadge status={lead.status} />
              </div>
            </div>

            {/* Lead Fields Section */}
            <div className="space-y-4">
              <div className="border-b border-[--border] pb-2 mb-4">
                <h3 className="text-sm font-black text-[--text-primary] uppercase tracking-wide">Lead Fields</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {lead.lead_type === 'POSITIVE' ? (
                  <>
                    {/* Positive Template Fields */}
                    {/* 1. Date */}
                    <FormField
                      label="Date"
                      editMode={editMode}
                      editContent={<input type="date" {...register('data.date')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{formatDate(lead.data?.date)}</span>}
                    />

                    {/* 3. Business type */}
                    <FormField
                      label="Business Type"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.businessType')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.businessType || '-'}</span>}
                    />

                    {/* 4. Business / Person / Shop / Company name */}
                    <FormField
                      label="Business / Person / Shop / Company Name *"
                      editMode={editMode}
                      editContent={
                        <input
                          type="text"
                          required
                          {...register('name', { required: 'Business name is required' })}
                        />
                      }
                      viewContent={<span className="text-sm text-[--text-primary] py-2 font-semibold">{lead.name || lead.business_name || lead.businessName || '-'}</span>}
                    />

                    {/* 5. Area */}
                    <FormField
                      label="Area"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.area')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.area || '-'}</span>}
                    />

                    {/* 6. City */}
                    <FormField
                      label="City"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.city')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.city || '-'}</span>}
                    />

                    {/* 7. Contact number */}
                    <FormField
                      label="Contact Number *"
                      editMode={editMode}
                      editContent={
                        <input
                          type="text"
                          required
                          {...register('phone', { required: 'Contact number is required' })}
                        />
                      }
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.phone || '-'}</span>}
                    />

                    {/* 8. Point of Contact */}
                    <FormField
                      label="Point of Contact"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.pointOfContact')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.pointOfContact || '-'}</span>}
                    />

                    {/* 11. Remarks */}
                    <FormField
                      label="Remarks"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.remarks')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.remarks || '-'}</span>}
                    />

                    {/* 12. Recordings */}
                    <FormField
                      label="Recordings"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.recordings')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.recordings || '-'}</span>}
                    />

                    {/* 13. Follow-up required */}
                    <FormField
                      label="Follow-up required"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.followUpRequired')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.followUpRequired || '-'}</span>}
                    />

                    {/* 14. Follow-ups */}
                    <FormField
                      label="Follow-ups"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.followUps')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.followUps || '-'}</span>}
                    />

                    {/* 15. Follow-up dates */}
                    <FormField
                      label="Follow-up dates"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.followUpDates')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.followUpDates || '-'}</span>}
                    />

                    {/* 16. Follow-up remarks */}
                    <FormField
                      label="Follow-up remarks"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.followUpRemarks')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.followUpRemarks || '-'}</span>}
                    />

                    {/* 17. Requirement if any */}
                    <FormField
                      label="Requirement if any"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.requirement')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.requirement || '-'}</span>}
                    />

                    {/* 18. A notes to the cos team only */}
                    <FormField
                      label="A notes to the cos team only"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.notes')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.notes || '-'}</span>}
                    />
                  </>
                ) : (
                  <>
                    {/* Standard (COS) Template Fields */}
                    {/* 1. Date */}
                    <FormField
                      label="Date"
                      editMode={editMode}
                      editContent={<input type="date" {...register('data.date')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{formatDate(lead.data?.date)}</span>}
                    />

                    {/* 3. Business type */}
                    <FormField
                      label="Business Type"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.businessType')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.businessType || '-'}</span>}
                    />

                    {/* 4. Business person, shop, and company name */}
                    <FormField
                      label="Business / Person / Shop / Company Name *"
                      editMode={editMode}
                      editContent={
                        <input
                          type="text"
                          required
                          {...register('name', { required: 'Business name is required' })}
                        />
                      }
                      viewContent={<span className="text-sm text-[--text-primary] py-2 font-semibold">{lead.name || lead.business_name || lead.businessName || '-'}</span>}
                    />

                    {/* 5. Contact number */}
                    <FormField
                      label="Contact Number *"
                      editMode={editMode}
                      editContent={
                        <input
                          type="text"
                          required
                          {...register('phone', { required: 'Contact number is required' })}
                        />
                      }
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.phone || '-'}</span>}
                    />

                    {/* 6. Point of Contact */}
                    <FormField
                      label="Point of Contact"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.pointOfContact')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.pointOfContact || '-'}</span>}
                    />

                    {/* 8. Area */}
                    <FormField
                      label="Area"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.area')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.area || '-'}</span>}
                    />

                    {/* 9. City */}
                    <FormField
                      label="City"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.city')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.city || '-'}</span>}
                    />

                    {/* 11. Link address */}
                    <FormField
                      label="Link Address"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.deliveredLocation')} />}
                      viewContent={
                        lead.data?.deliveredLocation ? (
                          <div className="py-2">
                            <a href={lead.data.deliveredLocation} target="_blank" rel="noreferrer" className="text-[--accent] hover:underline inline-flex items-center gap-1 font-semibold">
                              <span>View Link</span>
                              <ExternalLink size={12} />
                            </a>
                          </div>
                        ) : (
                          <span className="text-sm text-[--text-primary] py-2">-</span>
                        )
                      }
                    />

                    {/* 12. Remarks */}
                    <FormField
                      label="Remarks"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.remarks')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.remarks || '-'}</span>}
                    />

                    {/* 12.1. Recordings */}
                    <FormField
                      label="Recordings"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.recordings')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.recordings || '-'}</span>}
                    />

                    {/* 14. Appointment type (yes or no) */}
                    <FormField
                      label="Appointment type (yes or no)"
                      editMode={editMode}
                      editContent={
                        <select {...register('data.appointmentType')}>
                          <option value="">-- Select --</option>
                          <option value="YES">YES</option>
                          <option value="NO">NO</option>
                        </select>
                      }
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.appointmentType || '-'}</span>}
                    />

                    {/* 15. Appointment date */}
                    <FormField
                      label="Appointment date"
                      editMode={editMode}
                      editContent={<input type="date" {...register('data.appointmentDate')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{formatDate(lead.data?.appointmentDate)}</span>}
                    />

                    {/* 13. Appointment time */}
                    <FormField
                      label="Appointment time"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.appointmentTime')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.appointmentTime || '-'}</span>}
                    />

                    {/* 17. Requirement order if any */}
                    <FormField
                      label="Requirement order if any"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.requirement')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.requirement || '-'}</span>}
                    />

                    {/* 18. Notes to the cos if any */}
                    <FormField
                      label="Notes to the cos if any"
                      editMode={editMode}
                      editContent={<input type="text" {...register('data.notes')} />}
                      viewContent={<span className="text-sm text-[--text-primary] py-2">{lead.data?.notes || '-'}</span>}
                    />
                  </>
                )}
              </div>
              {/* Validation Errors for Main Form Fields */}
              <div className="flex flex-col gap-1">
                {errors.name && <span className="text-red-500 text-xs font-semibold">{errors.name.message}</span>}
                {errors.phone && <span className="text-red-500 text-xs font-semibold">{errors.phone.message}</span>}
              </div>
            </div>

            {/* Assigning Section */}
            <div className="border-t border-[--border-strong] pt-5 space-y-4">
              <div className="border-b border-[--border] pb-2 mb-4">
                <h3 className="text-sm font-black text-[--text-primary] uppercase tracking-wide">Assigning</h3>
              </div>
              <div className={`grid grid-cols-1 ${lead.lead_type === 'POSITIVE' ? '' : 'md:grid-cols-2'} gap-4`}>
                {/* 19. Lead type */}
                {lead.lead_type !== 'POSITIVE' && (
                  <FormField
                    label="Lead Type"
                    editMode={editMode}
                    editContent={
                      <select {...register('leadType')}>
                        <option value="CALL">Call Inquiry (Remote)</option>
                        <option value="FIELD">Field Visit (On-Site)</option>
                      </select>
                    }
                    viewContent={
                      <div className="py-2 font-semibold">
                        {lead.lead_type === 'FIELD' ? (
                          <span className="px-2 py-0.5 bg-sky-50 text-sky-600 border border-sky-200 text-[10px] rounded uppercase font-bold">
                            FIELD VISIT
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 bg-stone-100 text-stone-600 border border-stone-200 text-[10px] rounded uppercase font-bold">
                            CALL INQUIRY
                          </span>
                        )}
                      </div>
                    }
                  />
                )}

                {/* 20. Sub vertical */}
                <FormField
                  label="Sub Vertical"
                  editMode={editMode}
                  editContent={
                    <select {...register('subVerticalId')}>
                      <option value="">-- Choose Sub-vertical --</option>
                      {subVerticals.map(sub => (
                        <option key={sub._id} value={sub._id}>{sub.name}</option>
                      ))}
                    </select>
                  }
                  viewContent={
                    <div className="flex items-center gap-1.5 py-2 text-sm text-[--text-primary]">
                      <Briefcase size={14} className="text-[--accent]" />
                      <span>{lead.sv_name || 'Unclassified'}</span>
                    </div>
                  }
                />
              </div>
            </div>

            {/* Custom fields & stage section */}
            {(customFields.length > 0 || (editMode && stages.length > 0) || (!editMode && lead.stage_id)) && (
              <div className="border-t border-[--border-strong] pt-5 space-y-4">
                <div className="border-b border-[--border] pb-2 mb-4">
                  <h3 className="text-sm font-black text-[--text-primary] uppercase tracking-wide">
                    Sub-Vertical Specific Fields
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Lead Stage */}
                  {((editMode && stages.length > 0) || (!editMode && lead.stage_id)) && (
                    <FormField
                      label="Lead Stage"
                      editMode={editMode}
                      editContent={
                        <select {...register('stageId')}>
                          <option value="">-- None --</option>
                          {stages.map(st => (
                            <option key={st.id} value={st.id}>{st.name}</option>
                          ))}
                        </select>
                      }
                      viewContent={
                        <div className="py-2 text-sm text-[--text-primary] font-semibold">
                          {stages.find(st => st.id === lead.stage_id || st.id === lead.stageId)?.name || 'None'}
                        </div>
                      }
                    />
                  )}

                  {/* Custom Fields */}
                  {customFields.map(field => {
                    const error = errors.customValues?.[field.field_key];

                    return (
                      <div key={field.id} className="flex flex-col gap-1.5">
                        <span className="text-xs font-bold text-[--text-secondary] uppercase">
                          {field.label} {field.is_required && <span className="text-red-500">*</span>}
                        </span>

                        {!editMode ? (
                          <div className="bg-stone-50 border border-[--border] rounded-lg px-3 py-2 text-xs text-[--text-primary] min-h-[36px] flex items-center">
                            {lead.customValues?.[field.field_key] !== undefined && lead.customValues?.[field.field_key] !== '' ? (
                              <span>{String(lead.customValues[field.field_key])}</span>
                            ) : (
                              <span className="text-[--text-muted] italic">Not Filled</span>
                            )}
                          </div>
                        ) : (
                          <div>
                            {field.field_type === 'select' ? (
                              <select 
                                {...register(`customValues.${field.field_key}`, { required: field.is_required ? 'Required field' : false })}
                              >
                                <option value="">-- Choose Option --</option>
                                {field.options?.map(opt => (
                                  <option key={opt} value={opt}>{opt}</option>
                                ))}
                              </select>
                            ) : field.field_type === 'multiselect' ? (
                              // Custom Multi-select checkboxes
                              <Controller
                                control={control}
                                name={`customValues.${field.field_key}`}
                                defaultValue={lead.customValues?.[field.field_key] ? String(lead.customValues[field.field_key]).split(',').map(s => s.trim()) : []}
                                rules={{ required: field.is_required ? 'Required field' : false }}
                                render={({ field: { value = [], onChange } }) => {
                                  const listVal = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim()).filter(Boolean);
                                  const handleChecked = (opt) => {
                                    const next = listVal.includes(opt) ? listVal.filter(v => v !== opt) : [...listVal, opt];
                                    onChange(next);
                                  };
                                  return (
                                    <div className="border border-[--border-strong] rounded-lg p-2 max-h-[100px] overflow-y-auto grid grid-cols-2 gap-1.5 bg-[--bg-input]">
                                      {field.options?.map(opt => (
                                        <label key={opt} className="flex items-center gap-1.5 text-xs text-[--text-secondary] cursor-pointer">
                                          <input
                                            type="checkbox"
                                            checked={listVal.includes(opt)}
                                            onChange={() => handleChecked(opt)}
                                            className="w-3.5 h-3.5 accent-[--accent]"
                                          />
                                          <span>{opt}</span>
                                        </label>
                                      ))}
                                    </div>
                                  );
                                }}
                              />
                            ) : field.field_type === 'boolean' ? (
                              <label className="flex items-center gap-2 cursor-pointer py-1.5">
                                <input
                                  type="checkbox"
                                  defaultChecked={lead.customValues?.[field.field_key] === 'true'}
                                  {...register(`customValues.${field.field_key}`)}
                                  className="w-4.5 h-4.5 accent-[--accent]"
                                />
                                <span className="text-xs text-[--text-secondary]">Enabled / Yes</span>
                              </label>
                            ) : field.field_type === 'textarea' ? (
                              <textarea
                                rows={2}
                                placeholder={field.placeholder}
                                {...register(`customValues.${field.field_key}`, { required: field.is_required ? 'Required field' : false })}
                              />
                            ) : field.field_type === 'date' ? (
                              <input
                                type="date"
                                {...register(`customValues.${field.field_key}`, { required: field.is_required ? 'Required field' : false })}
                              />
                            ) : field.field_type === 'number' ? (
                              <input
                                type="number"
                                placeholder={field.placeholder}
                                {...register(`customValues.${field.field_key}`, { required: field.is_required ? 'Required field' : false })}
                              />
                            ) : (
                              <input
                                type="text"
                                placeholder={field.placeholder}
                                {...register(`customValues.${field.field_key}`, { required: field.is_required ? 'Required field' : false })}
                              />
                            )}

                            {error && (
                              <span className="text-red-500 text-[10px] font-bold mt-0.5 block">
                                {error.message || 'Required field'}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Form Save Button */}
            {editMode && (
              <div className="flex justify-end pt-4 border-t border-[--border-strong]">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center gap-1.5 px-6 py-2.5 bg-[--accent] text-white font-black uppercase tracking-wider rounded-lg text-sm transition-all hover:bg-[--accent-hover] shadow-sm cursor-pointer"
                >
                  <Save size={16} />
                  <span>Save Changes</span>
                </button>
              </div>
            )}
          </div>
        </form>

        {/* Right Column: Geotagging, Follow-Ups, and Timeline */}
        <div className="space-y-6">
          
          {/* Field visit Geotagging Card (F4) */}
          {lead.lead_type === 'FIELD' && (
            <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm space-y-4">
              <h3 className="text-xs font-black text-[--text-primary] uppercase tracking-wider border-b border-[--border] pb-2 flex items-center gap-1.5">
                <MapPin size={16} className="text-[--accent]" />
                <span>Field Visit Geotagging</span>
              </h3>

              {/* Existing location coordinates */}
              {lead.geotag_lat && lead.geotag_lng ? (
                <div className="space-y-3 bg-stone-50 border border-[--border] rounded-xl p-3.5 text-xs text-[--text-secondary]">
                  <div className="flex justify-between items-center">
                    <strong className="text-[--text-primary]">Coordinates:</strong>
                    <span className="font-mono bg-white px-2 py-0.5 border rounded">
                      {lead.geotag_lat.toFixed(6)}, {lead.geotag_lng.toFixed(6)}
                    </span>
                  </div>
                  {lead.geotag_accuracy && (
                    <div className="flex justify-between">
                      <span>Accuracy:</span>
                      <span className="font-mono">±{lead.geotag_accuracy.toFixed(1)}m</span>
                    </div>
                  )}
                  {lead.geotag_captured_at && (
                    <div className="flex justify-between">
                      <span>Captured At:</span>
                      <span>{new Date(lead.geotag_captured_at).toLocaleString()}</span>
                    </div>
                  )}
                  {lead.geotag_photo_key && (
                    <div className="border border-stone-200 rounded-lg overflow-hidden mt-2">
                      <img 
                        src={lead.geotag_photo_key} 
                        alt="Field Visit Check-In" 
                        className="w-full h-auto object-cover max-h-48"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-4 bg-stone-50 border border-stone-200 border-dashed rounded-xl text-xs text-[--text-secondary] flex flex-col items-center justify-center gap-1 leading-relaxed">
                  <MapPin size={24} className="text-stone-300 animate-bounce" />
                  <span>No check-in location recorded for this field visit.</span>
                </div>
              )}

              {/* Geo Capture Actions */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCaptureGps}
                  disabled={capturingGps}
                  className="flex-1 py-2 bg-white border border-[--accent-border] hover:border-[--accent] text-[--accent] font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <MapPin size={13} />
                  <span>{capturingGps ? 'GPS Seeks...' : 'Record GPS'}</span>
                </button>

                <label className="flex-1 py-2 bg-[--accent] hover:bg-[--accent-hover] text-white font-black uppercase text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm cursor-pointer text-center select-none">
                  <Camera size={13} />
                  <span>{uploadingPhoto ? 'Extracting...' : 'Upload Photo'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    disabled={uploadingPhoto}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
          )}

          {/* Follow-Ups portal calendar scheduling section (F5) */}
          <div id="follow-ups-section" className="glass-panel p-5 bg-white border border-[--border] shadow-sm space-y-4 transition-all duration-300">
            <div className="flex justify-between items-center border-b border-[--border] pb-2">
              <h3 className="text-xs font-black text-[--text-primary] uppercase tracking-wider flex items-center gap-1.5">
                <ClipboardList size={16} className="text-[--accent]" />
                <span>Client Follow-Ups</span>
              </h3>
              
              {followUpSummary && (
                <span className="text-[9px] bg-amber-50 text-amber-600 border border-amber-200 px-1.5 py-0.5 rounded font-black">
                  {followUpSummary.pending} Scheduled
                </span>
              )}
            </div>

            {/* List of follow-ups */}
            <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
              {followUps.length === 0 ? (
                <div className="text-center py-6 text-xs text-[--text-secondary]">
                  No scheduled check-ins. Click Schedule to add a reminder.
                </div>
              ) : (
                followUps.map(item => {
                  const isPending = item.status === 'PENDING';
                  const isCompleted = item.status === 'COMPLETED';

                  return (
                    <div key={item.id} className="p-3 border border-[--border] rounded-xl text-xs space-y-2 bg-stone-50/30 hover:bg-stone-50 transition-all relative">
                      <div className="flex justify-between items-start">
                        <span className={`px-1.5 py-0.2 rounded text-[8px] font-black uppercase border ${
                          isCompleted ? 'bg-emerald-50 text-emerald-600 border-emerald-200' :
                          isPending ? 'bg-amber-50 text-amber-600 border-amber-200' :
                          'bg-rose-50 text-rose-600 border-rose-200'
                        }`}>
                          {item.status}
                        </span>
                        
                        <div className="flex gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => setEditingFollowUp({
                              id: item.id,
                              assigned_to_id: item.assigned_to_id || item.assigned_to || '',
                              follow_up_date: item.follow_up_date ? item.follow_up_date.slice(0, 16) : '',
                              description: item.description || '',
                              status: item.status || 'PENDING',
                              completed_note: item.completed_note || '',
                            })}
                            className="text-stone-400 hover:text-[--accent] bg-transparent border-0 cursor-pointer"
                            title="Edit follow-up"
                          >
                            <Edit size={11} />
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => handleDeleteFollowUp(item.id)}
                              className="text-stone-400 hover:text-red-500 bg-transparent border-0 cursor-pointer"
                              title="Delete follow-up"
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
                        </div>
                      </div>

                      <p className="text-[11px] text-[--text-secondary] leading-relaxed italic bg-white p-2 border border-stone-100 rounded">
                        "{item.description}"
                      </p>

                      <div className="flex justify-between text-[9px] text-[--text-muted] font-mono">
                        <span>Agent: {item.assigned_to_name}</span>
                        <span>{new Date(item.follow_up_date).toLocaleDateString()} {new Date(item.follow_up_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>

                      {item.completed_note && (
                        <div className="bg-emerald-50/20 text-emerald-800 text-[10px] p-1.5 border border-emerald-100 rounded flex gap-1 items-start leading-snug">
                          <MessageSquare size={11} className="shrink-0 mt-0.5 text-emerald-600" />
                          <span>{item.completed_note}</span>
                        </div>
                      )}

                      {isPending && completingFollowUpId !== item.id && (
                        <button
                          type="button"
                          onClick={() => setCompletingFollowUpId(item.id)}
                          className="w-full mt-2 py-1 bg-white border border-emerald-200 hover:border-transparent hover:bg-emerald-600 text-emerald-600 hover:text-white font-bold text-[9px] rounded transition-all cursor-pointer"
                        >
                          Mark Completed
                        </button>
                      )}

                      {completingFollowUpId === item.id && (
                        <form onSubmit={(e) => handleCompleteFollowUp(e, item.id)} className="mt-2 p-2 bg-white border rounded-lg space-y-2">
                          <span className="text-[9px] font-bold uppercase text-[--text-secondary] block">Visit Note:</span>
                          <textarea
                            value={completedNote}
                            onChange={(e) => setCompletedNote(e.target.value)}
                            required
                            rows={2}
                            placeholder="Store outcome details..."
                            className="bg-stone-50 border border-stone-200 rounded p-1 w-full text-[11px]"
                          />
                          <div className="flex gap-1 justify-end">
                            <button
                              type="button"
                              onClick={() => { setCompletingFollowUpId(null); setCompletedNote(''); }}
                              className="px-2 py-0.5 border text-[9px] rounded bg-white hover:bg-stone-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="px-2 py-0.5 bg-emerald-600 text-white font-bold text-[9px] rounded hover:bg-emerald-700"
                            >
                              Complete
                            </button>
                          </div>
                        </form>
                      )}

                    </div>
                  );
                })
              )}
            </div>

            {/* Schedule trigger button */}
            {!showScheduleForm ? (
              <button
                type="button"
                onClick={() => {
                  if (!lead.sub_vertical_id) {
                    toast.error("Please assign a sub-vertical classification to this lead first.");
                    return;
                  }
                  setShowScheduleForm(true);
                }}
                className="w-full py-2 bg-white border border-[--accent-border] hover:border-[--accent] text-[--accent] font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
              >
                <PlusCircle size={13} />
                <span>Schedule Check-In</span>
              </button>
            ) : (
              <form onSubmit={handleCreateFollowUp} className="bg-stone-50/50 border border-stone-200 rounded-xl p-3.5 space-y-3">
                <span className="text-[10px] font-black uppercase text-[--accent] tracking-wider block">Schedule Next Follow-Up</span>
                
                <div className="flex flex-col gap-1 text-[11px]">
                  <label className="font-bold text-[--text-secondary]">Target Date & Time</label>
                  <input
                    type="datetime-local"
                    required
                    value={scheduleDate}
                    onChange={(e) => setScheduleDate(e.target.value)}
                    className="bg-white border rounded p-1"
                  />
                </div>

                <div className="flex flex-col gap-1 text-[11px]">
                  <label className="font-bold text-[--text-secondary]">Employee Name</label>
                  <select
                    required
                    value={scheduleAgentId}
                    onChange={(e) => setScheduleAgentId(e.target.value)}
                    className="bg-white border rounded p-1"
                  >
                    <option value="">-- Choose Operator --</option>
                    {subVerticalUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1 text-[11px]">
                  <label className="font-bold text-[--text-secondary]">Summary / Instructions</label>
                  <textarea
                    required
                    rows={2}
                    placeholder="Describe check-in guidelines..."
                    value={scheduleDesc}
                    onChange={(e) => setScheduleDesc(e.target.value)}
                    className="bg-white border rounded p-1"
                  />
                </div>

                <div className="flex gap-1.5 justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => setShowScheduleForm(false)}
                    className="px-2.5 py-1 border text-[10px] font-bold rounded hover:bg-stone-50 bg-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={scheduling}
                    className="px-2.5 py-1 bg-[--accent] hover:bg-[--accent-hover] text-white font-black uppercase text-[10px] rounded transition-all"
                  >
                    {scheduling ? 'Scheduling...' : 'Schedule'}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Interaction History Log */}
          <div className="glass-panel p-6 bg-white border border-[--border] shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-[--text-primary] uppercase tracking-wider border-b border-[--border] pb-2 flex items-center gap-2">
              <MessageSquare size={14} className="text-amber-500" />
              Interaction History
              {interactionCount > 0 && (
                <span className="ml-auto bg-amber-100 text-amber-700 text-[9px] font-black px-1.5 py-0.5 rounded-full">
                  {interactionCount} logged
                </span>
              )}
            </h3>

            {/* Interaction log entries */}
            <div className="space-y-3">
              {interactionLogs.length === 0 ? (
                <div className="text-center py-4 text-[--text-muted] text-xs italic">
                  No interactions logged yet.
                </div>
              ) : (
                interactionLogs.map(log => {
                  const logDate = log.interaction_date
                    ? new Date(log.interaction_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                    : '-';
                  const loggedBy = log.recorded_by_name || log.recorded_by_raw_name || 'Unknown';
                  const canDelete = isAdmin || (user?.sub === log.recorded_by);
                  const OUTCOME_COLORS = {
                    'Interested':          'bg-emerald-100 text-emerald-700',
                    'Not Reachable':       'bg-slate-100 text-slate-600',
                    'Callback Requested':  'bg-blue-100 text-blue-700',
                    'Not Interested':      'bg-red-100 text-red-600',
                    'Converted':           'bg-purple-100 text-purple-700',
                  };
                  const outcomeClass = log.outcome ? (OUTCOME_COLORS[log.outcome] || 'bg-stone-100 text-stone-600') : null;
                  return (
                    <div key={log.id} className="border border-[--border] rounded-lg p-2.5 bg-stone-50/60 text-[11px] space-y-1 group relative">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-[--text-primary]">{logDate}</span>
                        {log.outcome && (
                          <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${outcomeClass}`}>
                            {log.outcome}
                          </span>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDeleteInteractionLog(log.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-600 ml-auto"
                            title="Delete this entry"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                      {log.interaction_time && (
                        <div className="text-[--text-muted]">
                          <Clock size={9} className="inline mr-1" />
                          {log.interaction_time}
                        </div>
                      )}
                      {log.remarks && (
                        <p className="text-[--text-secondary] leading-relaxed">{log.remarks}</p>
                      )}
                      {log.next_followup_date && (
                        <div className="text-blue-600 font-medium">
                          Next: {new Date(log.next_followup_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </div>
                      )}
                      <div className="text-[9px] text-[--text-muted] mt-1">
                        Logged by <span className="font-semibold">{loggedBy}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Log Interaction button / form */}
            {!showAddInteraction ? (
              <button
                type="button"
                onClick={() => setShowAddInteraction(true)}
                className="w-full py-2 bg-white border border-amber-200 hover:border-amber-400 text-amber-600 font-bold text-xs rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
              >
                <PlusCircle size={13} />
                <span>Log Interaction</span>
              </button>
            ) : (
              <form onSubmit={handleCreateInteractionLog} className="bg-amber-50/60 border border-amber-200 rounded-xl p-3.5 space-y-3">
                <span className="text-[10px] font-black uppercase text-amber-600 tracking-wider block">Log New Interaction</span>

                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-[--text-secondary]">Date <span className="text-red-500">*</span></label>
                    <input
                      type="date"
                      required
                      value={interactionForm.interactionDate}
                      onChange={e => setInteractionForm(f => ({ ...f, interactionDate: e.target.value }))}
                      className="bg-white border rounded p-1 text-[11px]"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-[--text-secondary]">Time (optional)</label>
                    <input
                      type="text"
                      placeholder="e.g. 10:00 AM"
                      value={interactionForm.interactionTime}
                      onChange={e => setInteractionForm(f => ({ ...f, interactionTime: e.target.value }))}
                      className="bg-white border rounded p-1 text-[11px]"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-[11px]">
                  <label className="font-bold text-[--text-secondary]">Outcome</label>
                  <select
                    value={interactionForm.outcome}
                    onChange={e => setInteractionForm(f => ({ ...f, outcome: e.target.value }))}
                    className="bg-white border rounded p-1 text-[11px]"
                  >
                    <option value="">-- No outcome --</option>
                    {['Interested', 'Not Reachable', 'Callback Requested', 'Not Interested', 'Converted'].map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1 text-[11px]">
                  <label className="font-bold text-[--text-secondary]">Remarks</label>
                  <textarea
                    rows={2}
                    placeholder="Notes from this interaction..."
                    value={interactionForm.remarks}
                    onChange={e => setInteractionForm(f => ({ ...f, remarks: e.target.value }))}
                    className="bg-white border rounded p-1 text-[11px] resize-none"
                  />
                </div>

                <div className="flex flex-col gap-1 text-[11px]">
                  <label className="font-bold text-[--text-secondary]">Next Follow-up Date</label>
                  <input
                    type="date"
                    value={interactionForm.nextFollowupDate}
                    onChange={e => setInteractionForm(f => ({ ...f, nextFollowupDate: e.target.value }))}
                    className="bg-white border rounded p-1 text-[11px]"
                  />
                </div>

                <div className="flex gap-1.5 justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => { setShowAddInteraction(false); }}
                    className="px-2.5 py-1 border text-[10px] font-bold rounded hover:bg-stone-50 bg-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingInteraction}
                    className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white font-black uppercase text-[10px] rounded transition-all"
                  >
                    {savingInteraction ? 'Saving...' : 'Log It'}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Lead creation and info metrics metadata */}
          <div className="glass-panel p-6 bg-white border border-[--border] shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-[--text-primary] uppercase tracking-wider border-b border-[--border] pb-2 flex items-center gap-2">
              <Calendar size={16} className="text-[--accent]" /> Metadata History
            </h3>

            
            <div className="space-y-2.5 text-xs text-[--text-secondary] font-mono">
              <div className="flex justify-between">
                <span>Created At:</span>
                <span className="text-[--text-primary]">{new Date(lead.created_at || lead.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Created By:</span>
                <span className="text-[--text-primary]">{lead.uploadedBy?.name || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span>Upload Source:</span>
                <span className="text-[--text-primary] uppercase">{lead.source}</span>
              </div>
            </div>
          </div>

          {/* Audit History Log */}
          <div className="glass-panel p-6 bg-white border border-[--border] shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-[--text-primary] uppercase tracking-wider border-b border-[--border] pb-2">
              Activity History Log
            </h3>
            <AuditTimeline targetId={id} />
          </div>

        </div>

      </div>
      {editingFollowUp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-md p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl rounded-xl space-y-4">
            <div className="flex items-center justify-between border-b border-[--border] pb-3">
              <h3 className="text-lg font-bold text-[--text-primary] flex items-center gap-2">
                <Calendar className="text-[--accent]" size={20} />
                <span>Edit Follow-Up Visit</span>
              </h3>
              <button onClick={() => setEditingFollowUp(null)} className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:bg-stone-50">
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleUpdateFollowUpSubmit} className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-black uppercase text-[--text-secondary]">Assignee Agent *</span>
                <select
                  className="w-full"
                  value={editingFollowUp.assigned_to_id}
                  onChange={(e) => setEditingFollowUp({ ...editingFollowUp, assigned_to_id: e.target.value })}
                >
                  <option value="">-- Unassigned --</option>
                  {(subVerticalUsers.length > 0 ? subVerticalUsers : agents).map((a) => (
                    <option key={a.id || a._id} value={a.id || a._id}>{a.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-black uppercase text-[--text-secondary]">Follow-Up Date & Time *</span>
                <input
                  type="datetime-local"
                  required
                  className="w-full"
                  value={editingFollowUp.follow_up_date}
                  onChange={(e) => setEditingFollowUp({ ...editingFollowUp, follow_up_date: e.target.value })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-black uppercase text-[--text-secondary]">Visit Description / Agenda *</span>
                <textarea
                  required
                  rows={3}
                  className="w-full"
                  placeholder="Detail the instructions or agenda..."
                  value={editingFollowUp.description}
                  onChange={(e) => setEditingFollowUp({ ...editingFollowUp, description: e.target.value })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-black uppercase text-[--text-secondary]">Status *</span>
                <select
                  className="w-full"
                  value={editingFollowUp.status}
                  onChange={(e) => setEditingFollowUp({ ...editingFollowUp, status: e.target.value })}
                >
                  <option value="PENDING">PENDING</option>
                  <option value="COMPLETED">COMPLETED</option>
                  <option value="MISSED">MISSED</option>
                </select>
              </div>

              {editingFollowUp.status === 'COMPLETED' && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-black uppercase text-[--text-secondary]">Completion Note *</span>
                  <textarea
                    required
                    rows={3}
                    className="w-full"
                    placeholder="Visit outcome report notes..."
                    value={editingFollowUp.completed_note}
                    onChange={(e) => setEditingFollowUp({ ...editingFollowUp, completed_note: e.target.value })}
                  />
                </div>
              )}

              <div className="flex justify-end gap-3 pt-3 border-t border-[--border]">
                <button
                  type="button"
                  onClick={() => setEditingFollowUp(null)}
                  className="px-4 py-2 border border-[--border-strong] hover:bg-stone-50 rounded-lg text-xs font-semibold text-[--text-secondary]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[--accent] text-white hover:bg-[--accent-hover] rounded-lg text-xs font-bold shadow-sm"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

const FormField = ({ label, editMode, editContent, viewContent }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs font-bold text-[--text-secondary] uppercase">{label}</span>
    {editMode ? editContent : viewContent}
  </div>
);

export default LeadDetailPage;
