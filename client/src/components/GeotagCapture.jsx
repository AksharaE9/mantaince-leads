import React, { useState, useEffect } from 'react';

export const GeotagCapture = ({ leadType, onChange, onCapture, onPhotoSelect, existingCoords }) => {
  const [gpsData, setGpsData] = useState(existingCoords || null);

  useEffect(() => {
    if (existingCoords) {
      setGpsData(existingCoords);
    }
  }, [existingCoords]);

  if (leadType && leadType !== 'FIELD_VISIT' && leadType !== 'FIELD') return null;

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (onPhotoSelect) onPhotoSelect(file);

    try {
      // Extract EXIF data
      const exifrModule = await import('exifr');
      const gps = await exifrModule.default.gps(file);
      if (gps && gps.latitude && gps.longitude) {
        const coords = { lat: gps.latitude, lng: gps.longitude, accuracy: 10 };
        setGpsData(coords);
        if (onChange) onChange(coords, file);
        if (onCapture) onCapture(coords);
      } else {
        // Fallback to Geolocation API
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const coords = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy || 15
              };
              setGpsData(coords);
              if (onChange) onChange(coords, file);
              if (onCapture) onCapture(coords);
            },
            (error) => {
              console.error('Geolocation failed', error);
              if (onChange) onChange(null, file);
              if (onCapture) onCapture(null);
            }
          );
        } else {
          if (onChange) onChange(null, file);
          if (onCapture) onCapture(null);
        }
      }
    } catch (err) {
      console.error('EXIF parsing failed', err);
      if (onChange) onChange(null, file);
      if (onCapture) onCapture(null);
    }
  };

  return (
    <div className="border border-stone-200 rounded-xl p-4 bg-stone-50 space-y-3" data-testid="geotag-section">
      <h4 className="text-xs font-bold uppercase text-stone-500">Field Visit Details</h4>
      <input
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handlePhotoUpload}
        className="block w-full text-xs text-stone-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-[--accent-light] file:text-[--accent] hover:file:bg-[--accent-light]/80 cursor-pointer"
      />
      {gpsData && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <label className="text-[10px] text-stone-400 block uppercase">Latitude</label>
            <input
              type="text"
              readOnly
              data-testid="geotag-lat"
              value={gpsData.lat}
              className="bg-white border border-stone-200 rounded px-2 py-1 w-full"
            />
          </div>
          <div>
            <label className="text-[10px] text-stone-400 block uppercase">Longitude</label>
            <input
              type="text"
              readOnly
              data-testid="geotag-lng"
              value={gpsData.lng}
              className="bg-white border border-stone-200 rounded px-2 py-1 w-full"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default GeotagCapture;
