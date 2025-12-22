"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { Globe, Link as LinkIcon, Tag, ListFilter } from "lucide-react";
import LoadingSpinner from "./LoadingSpinner";

interface DomainFormProps {
  onSuccess?: () => void;
  onSave?: () => void;
}

export default function DomainForm({ onSuccess, onSave }: DomainFormProps) {
  const [formData, setFormData] = useState({
    domain_name: "",
    display_name: "",
    uptime_url: "",
    category: "Live Website",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const supabase = createClient();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const addDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    
    // Input validation
    if (!formData.domain_name || !formData.uptime_url) {
      setError("Domain name and uptime URL are required");
      return;
    }

    try {
      setLoading(true);
      const { data, error } = await supabase.from("domains").insert([
        {
          domain_name: formData.domain_name,
          display_name: formData.display_name || null,
          uptime_url: formData.uptime_url,
          category: formData.category,
        },
      ]).select();

      if (error) throw error;
      
      // Check the domain's uptime immediately after adding
      if (data && data.length > 0) {
        try {
          // Use the check uptime API
          const response = await fetch('/api/check/uptime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              domainId: data[0].id, 
              url: data[0].uptime_url 
            })
          });
          
          // The notification will be triggered by the API if the site is down
          console.log('Initial uptime check performed for new domain');
        } catch (checkError) {
          console.error('Failed to perform initial uptime check:', checkError);
        }
      }
      
      setSuccess("Domain added successfully!");
      setFormData({
        domain_name: "",
        display_name: "",
        uptime_url: "",
        category: "Live Website",
      });
      
      // Call callbacks
      if (onSuccess) onSuccess();
      if (onSave) onSave();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div id="add-domain-form" className="card mb-8">
      <div className="card-header flex flex-row justify-between ">
        <div>
        <h2 className="card-title">Add New Domain</h2>
        <p className="card-description">Add a new domain to monitor its uptime, SSL certificate, and expiry date</p>
        </div>
        <div>
        <div className="flex ">
          <button
            type="submit"
            form="domain-form"
            disabled={loading}
            className="btn-brand"
          >
            {loading ? (
              <>
                <LoadingSpinner size="sm" />
                <span>Processing...</span>
              </>
            ) : "Add Domain"}
          </button>
        </div>
        </div>
      </div>

     
      
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
          {error}
        </div>
      )}
      
      {success && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-md text-green-600 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
          {success}
        </div>
      )}
      
      <form id="domain-form" onSubmit={addDomain} className="mt-2 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label htmlFor="domain_name" className="block text-sm font-medium text-foreground mb-1">
              Domain Name*
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Globe className="h-4 w-4 text-muted-foreground" />
              </div>
              <input
                type="text"
                id="domain_name"
                name="domain_name"
                value={formData.domain_name}
                onChange={handleInputChange}
                placeholder="example.com"
                className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                required
              />
            </div>
          </div>
          
          <div>
            <label htmlFor="display_name" className="block text-sm font-medium text-foreground mb-1">
              Display Name (Optional)
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Tag className="h-4 w-4 text-muted-foreground" />
              </div>
              <input
                type="text"
                id="display_name"
                name="display_name"
                value={formData.display_name}
                onChange={handleInputChange}
                placeholder="My Website"
                className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
              />
            </div>
          </div>
          
          <div>
            <label htmlFor="uptime_url" className="block text-sm font-medium text-foreground mb-1">
              URL to Check*
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <LinkIcon className="h-4 w-4 text-muted-foreground" />
              </div>
              <input
                type="url"
                id="uptime_url"
                name="uptime_url"
                value={formData.uptime_url}
                onChange={handleInputChange}
                placeholder="https://example.com"
                className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                required
              />
            </div>
          </div>
          
          <div>
            <label htmlFor="category" className="block text-sm font-medium text-foreground mb-1">
              Category
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <ListFilter className="h-4 w-4 text-muted-foreground" />
              </div>
              <select
                id="category"
                name="category"
                value={formData.category}
                onChange={handleSelectChange}
                className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
              >
                <option value="Live Website">Live Website</option>
                <option value="Live Website Temporary Suspended">Live Website Temporary Suspended</option>
                <option value="Migration Done">Migration Done</option>
                <option value="Migration Pending">Migration Pending</option>
                <option value="Draft Website">Draft Website</option>
                <option value="Draft Suspended Website">Draft Suspended Website</option>
              </select>
            </div>
          </div>
        </div>
        
       
      </form>
    </div>
  );
} 