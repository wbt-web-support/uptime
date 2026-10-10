import nodemailer from 'nodemailer';
import msg91 from 'msg91';

interface AlertOptions {
  type: 'downtime' | 'ssl-expiry' | 'domain-expiry' | 'ip-change';
  domain: string;
  displayName?: string;
  message: string;
  daysRemaining?: number;
}

// Configure email transporter
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

// Initialize MSG91
const msg91Client = process.env.MSG91_AUTH_KEY 
  ? msg91.initialize({ authKey: process.env.MSG91_AUTH_KEY })
  : null;

// Send email notification
export async function sendEmailAlert(
  options: AlertOptions,
  recipients: string[]
): Promise<boolean> {
  if (!recipients.length) return false;
  
  try {
    const subject = getSubjectByAlertType(options);
    
    // Create HTML content with better formatting
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 5px;">
        <h1 style="color: ${getAlertColor(options.type)}; margin-top: 0;">${subject}</h1>
        <p style="font-size: 16px; line-height: 1.5;">${options.message}</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin-top: 20px;">
          <h3 style="margin-top: 0;">Alert Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Domain</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${options.displayName || options.domain}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">URL</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${options.domain}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Alert Type</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${formatAlertType(options.type)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Time</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${new Date().toLocaleString()}</td>
            </tr>
            ${options.daysRemaining !== undefined ? `
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Days Remaining</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${options.daysRemaining}</td>
            </tr>
            ${(options.type === 'ssl-expiry' || options.type === 'domain-expiry') ? `
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Expiry Date</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${new Date(Date.now() + options.daysRemaining * 24 * 60 * 60 * 1000).toLocaleDateString()}</td>
            </tr>
            ` : ''}
            ` : ''}
          </table>
        </div>
        
        <div style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">
          <p>This is an automated message from your Uptime Monitor service.</p>
        </div>
      </div>
    `;
    
    const result = await emailTransporter.sendMail({
      from: process.env.SMTP_FROM || 'alerts@example.com',
      to: recipients.join(', '),
      subject,
      text: options.message,
      html: htmlContent,
    });
    
    console.log(`Email alert sent for ${options.domain}: ${options.type} to ${recipients.length} recipients`);
    return true;
  } catch (error) {
    console.error('Failed to send email alert:', error);
    return false;
  }
}

// A funnel test changed result: it broke, or it works again. Sent to
// FUNNEL_ALERT_EMAILS (comma-separated), or ADMIN_EMAIL when that isn't set.
export async function sendFunnelAlert(options: {
  kind: 'broken' | 'fixed';
  funnelName: string;
  funnelUrl: string;
  reason: string | null;
  reportUrl: string;
}): Promise<boolean> {
  const recipients = (process.env.FUNNEL_ALERT_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);
  if (!recipients.length || !process.env.SMTP_HOST) return false;

  const broken = options.kind === 'broken';
  const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const subject = broken
    ? `Funnel not working: ${options.funnelName}`
    : `Funnel working again: ${options.funnelName}`;
  const text = broken
    ? `The quote funnel "${options.funnelName}" (${options.funnelUrl}) stopped working in its latest test.\n\nWhy: ${options.reason ?? 'see the report'}\n\nFull report: ${options.reportUrl}`
    : `The quote funnel "${options.funnelName}" (${options.funnelUrl}) works again - every stage passed in its latest test.\n\nReport: ${options.reportUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 5px;">
      <h1 style="color: ${broken ? '#d32f2f' : '#2e7d32'}; margin-top: 0; font-size: 22px;">${escape(subject)}</h1>
      <p style="font-size: 15px; line-height: 1.5;">
        ${broken ? 'This quote funnel stopped working in its latest test.' : 'This quote funnel works again - every stage passed in its latest test.'}
      </p>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold; width: 110px;">Funnel</td><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${escape(options.funnelName)}</td></tr>
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Page</td><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${escape(options.funnelUrl)}</td></tr>
        ${broken ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Why</td><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${escape(options.reason ?? 'See the report')}</td></tr>` : ''}
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-weight: bold;">Time</td><td style="padding: 8px 0; border-bottom: 1px solid #e0e0e0;">${new Date().toLocaleString('en-GB')}</td></tr>
      </table>
      <p style="margin-top: 20px;"><a href="${escape(options.reportUrl)}" style="background: #1a73e8; color: #fff; padding: 10px 16px; border-radius: 4px; text-decoration: none;">Open the website report</a></p>
      <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message from your Uptime Monitor's Funnel Test.</p>
    </div>
  `;
  try {
    await emailTransporter.sendMail({ from: process.env.SMTP_FROM || 'alerts@example.com', to: recipients.join(', '), subject, text, html });
    console.log(`Funnel alert sent (${options.kind}) for ${options.funnelName} to ${recipients.length} recipient(s)`);
    return true;
  } catch (error) {
    console.error('Failed to send funnel alert:', error);
    return false;
  }
}

// Send SMS notification
export async function sendSMSAlert(
  options: AlertOptions,
  phoneNumbers: string[]
): Promise<boolean> {
  // Log MSG91 configuration status
  console.log('SMS Alert - Configuration Check:');
  console.log(`- MSG91 Auth Key: ${process.env.MSG91_AUTH_KEY ? 'Configured' : 'Missing'}`);
  console.log(`- MSG91 Template ID: ${process.env.MSG91_TEMPLATE_ID || 'Missing'}`);
  console.log(`- Phone Recipients: ${phoneNumbers.length} recipient(s)`);
  
  if (!process.env.MSG91_AUTH_KEY) {
    console.error('SMS Alert - Error: MSG91 Auth Key is not configured. Check your MSG91_AUTH_KEY environment variable.');
    return false;
  }
  
  if (!process.env.MSG91_TEMPLATE_ID) {
    console.error('SMS Alert - Error: MSG91 Template ID is missing. Configure the MSG91_TEMPLATE_ID environment variable.');
    return false;
  }
  
  if (!phoneNumbers.length) {
    console.log('SMS Alert - Info: No phone numbers to send SMS to.');
    return false;
  }
  
  try {
    const subject = getSubjectByAlertType(options);
    
    // Keep SMS messages concise but with enough information
    const messageBody = `${subject}: ${options.message}`;
    
    console.log(`SMS Alert - Attempting to send to ${phoneNumbers.length} recipient(s)`);
    console.log(`SMS Alert - Message: ${messageBody.substring(0, 100)}${messageBody.length > 100 ? '...' : ''}`);
    
    // Format date for better readability
    const formattedDate = new Date().toLocaleString();
    
    // Prepare recipients with all required variables for the template
    const recipients = phoneNumbers.map(phone => ({
      mobiles: phone.replace(/^\+/, ''), // Remove leading '+' as MSG91 doesn't need it
      "##ALERT_TYPE##": formatAlertType(options.type),
      "##ALERT_SUBJECT##": subject,
      "##MESSAGE##": options.message,
      "##DOMAIN_NAME##": options.displayName || options.domain,
      "##DOMAIN_URL##": options.domain,
      "##DAYS_REMAINING##": options.daysRemaining?.toString() || '',
      "##DATE_TIME##": formattedDate
    }));
    
    // Prepare the request body according to MSG91 Flow API format
    const requestBody = {
      template_id: process.env.MSG91_TEMPLATE_ID,
      short_url: "0", // Default to not using short URLs
      recipients: recipients
    };
    
    // Send SMS using MSG91 Flow API
    const results = await Promise.all(
      phoneNumbers.map(async (phone, index) => {
        try {
          console.log(`SMS Alert - Sending to: ${phone}`);
          
          // Make direct API call to MSG91
          const response = await fetch('https://control.msg91.com/api/v5/flow', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'accept': 'application/json',
              'authkey': process.env.MSG91_AUTH_KEY || ''
            },
            body: JSON.stringify({
              ...requestBody,
              recipients: [recipients[index]]
            })
          });
          
          const responseData = await response.json();
          
          if (!response.ok) {
            console.error(`SMS Alert - Error response: ${JSON.stringify(responseData)}`);
            return { success: false, error: responseData };
          }
          
          console.log(`SMS Alert - Successfully sent to ${phone}. Response:`, responseData);
          return { success: true, response: responseData };
        } catch (error: any) {
          console.error(`SMS Alert - Failed to send to ${phone}:`, error);
          
          // More detailed error logging
          if (error.code) {
            console.error(`SMS Alert - Error Code: ${error.code}`);
          }
          if (error.message) {
            console.error(`SMS Alert - Error Message: ${error.message}`);
          }
          if (error.status) {
            console.error(`SMS Alert - Error Status: ${error.status}`);
          }
          
          return { success: false, error };
        }
      })
    );
    
    const successful = results.filter(r => r.success).length;
    console.log(`SMS Alert - Results: ${successful}/${phoneNumbers.length} messages sent successfully`);
    
    return successful > 0;
  } catch (error) {
    console.error('SMS Alert - Failed to send SMS alerts:', error);
    return false;
  }
}

// Helper function to get subject based on alert type
function getSubjectByAlertType(options: AlertOptions): string {
  const domainName = options.displayName || options.domain;
  
  switch (options.type) {
    case 'downtime':
      return `🔴 ALERT: ${domainName} is DOWN`;
    case 'ssl-expiry':
      return `⚠️ SSL Certificate Expiring: ${domainName}`;
    case 'domain-expiry':
      return `⚠️ Domain Expiring: ${domainName}`;
    case 'ip-change':
      return `ℹ️ IP Change Detected: ${domainName}`;
    default:
      return `Alert: ${domainName}`;
  }
}

// Helper function to get color based on alert type
function getAlertColor(type: string): string {
  switch (type) {
    case 'downtime':
      return '#dc2626'; // Red
    case 'ssl-expiry':
    case 'domain-expiry':
      return '#f59e0b'; // Amber
    case 'ip-change':
      return '#3b82f6'; // Blue
    default:
      return '#374151'; // Gray
  }
}

// Helper function to format alert type for display
function formatAlertType(type: string): string {
  switch (type) {
    case 'downtime':
      return 'Downtime Alert';
    case 'ssl-expiry':
      return 'SSL Certificate Expiration';
    case 'domain-expiry':
      return 'Domain Expiration';
    case 'ip-change':
      return 'IP Address Change';
    default:
      return type;
  }
} 