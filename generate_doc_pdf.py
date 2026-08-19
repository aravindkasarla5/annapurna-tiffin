import os
import sys
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable, KeepTogether
)
from reportlab.pdfgen import canvas

# Define Output PDF Path
output_pdf_path = os.path.join(os.getcwd(), 'public', 'Sri_Lakshmi_Annapurna_Tiffin_Center_Documentation.pdf')

class NumberedCanvas(canvas.Canvas):
    """
    Canvas for drawing headers, footers, and dynamic page counts (Page X of Y).
    """
    def __init__(self, *args, **kwargs):
        super(NumberedCanvas, self).__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_number(num_pages)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def draw_page_number(self, page_count):
        self.saveState()
        self.setFont("Helvetica-Bold", 8)
        self.setFillColor(colors.HexColor("#D9531E"))
        
        # Header (Top bar)
        self.drawString(54, 11 * 72 - 36, "SRI LAKSHMI ANNAPURNA TIFFIN CENTER — SYSTEM DOCUMENTATION")
        self.setStrokeColor(colors.HexColor("#EAA221"))
        self.setLineWidth(0.75)
        self.line(54, 11 * 72 - 42, 8.5 * 72 - 54, 11 * 72 - 42)
        
        # Footer (Bottom bar)
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#666666"))
        self.drawString(54, 36, "https://annapurna-tiffin-1.onrender.com | Official Technical Documentation")
        
        page_text = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(8.5 * 72 - 54, 36, page_text)
        self.setStrokeColor(colors.HexColor("#CCCCCC"))
        self.setLineWidth(0.5)
        self.line(54, 48, 8.5 * 72 - 54, 48)
        self.restoreState()

def build_pdf():
    doc = SimpleDocTemplate(
        output_pdf_path,
        pagesize=letter,
        leftMargin=54,
        rightMargin=54,
        topMargin=54,
        bottomMargin=60
    )

    styles = getSampleStyleSheet()

    # Custom Color Palette
    PRIMARY = colors.HexColor("#D9531E")       # Deep Warm Orange
    ACCENT_GOLD = colors.HexColor("#EAA221")   # Accent Gold
    DARK_BG = colors.HexColor("#1A1A22")       # Dark Surface
    TEXT_DARK = colors.HexColor("#222222")     # Text Dark
    MUTED = colors.HexColor("#555555")         # Muted Gray
    LIGHT_BG = colors.HexColor("#F8F9FA")      # Light Card Background
    BORDER_COLOR = colors.HexColor("#E0E0E0")  # Border Color

    # Custom Paragraph Styles
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=24,
        leading=28,
        textColor=PRIMARY,
        spaceAfter=6
    )

    subtitle_style = ParagraphStyle(
        'DocSubTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=16,
        textColor=ACCENT_GOLD,
        spaceAfter=15
    )

    h1_style = ParagraphStyle(
        'Heading1_Custom',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=18,
        textColor=PRIMARY,
        spaceBefore=14,
        spaceAfter=8,
        keepWithNext=True
    )

    h2_style = ParagraphStyle(
        'Heading2_Custom',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=14,
        textColor=TEXT_DARK,
        spaceBefore=10,
        spaceAfter=6,
        keepWithNext=True
    )

    body_style = ParagraphStyle(
        'Body_Custom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9.5,
        leading=14,
        textColor=TEXT_DARK,
        spaceAfter=6
    )

    bullet_style = ParagraphStyle(
        'Bullet_Custom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9.5,
        leading=14,
        textColor=TEXT_DARK,
        leftIndent=15,
        firstLineIndent=-10,
        spaceAfter=4
    )

    table_header_style = ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=8.5,
        leading=11,
        textColor=colors.white
    )

    table_cell_style = ParagraphStyle(
        'TableCell',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=11,
        textColor=TEXT_DARK
    )

    code_style = ParagraphStyle(
        'CodeStyle',
        parent=styles['Normal'],
        fontName='Courier',
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#C7254E"),
        backColor=colors.HexColor("#F9F2F4"),
        borderColor=colors.HexColor("#E1E1E8"),
        borderWidth=0.5,
        borderPadding=4,
        spaceAfter=4
    )

    story = []

    # Title & Header Banner
    story.append(Paragraph("Sri Lakshmi Annapurna Tiffin Center", title_style))
    story.append(Paragraph("Complete Web Application System & Architecture Documentation", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1.5, color=PRIMARY, spaceBefore=0, spaceAfter=12))

    # Metadata Quick Overview Table
    meta_data = [
        [Paragraph("<b>Application Name:</b>", table_cell_style), Paragraph("Sri Lakshmi Annapurna Tiffin Center", table_cell_style),
         Paragraph("<b>Version:</b>", table_cell_style), Paragraph("v1.0.0 (Production)", table_cell_style)],
        [Paragraph("<b>Live Website (Render):</b>", table_cell_style), Paragraph("<a href='https://annapurna-tiffin-1.onrender.com'>https://annapurna-tiffin-1.onrender.com</a>", table_cell_style),
         Paragraph("<b>Local Dev Server:</b>", table_cell_style), Paragraph("http://localhost:3000", table_cell_style)],
        [Paragraph("<b>GitHub Repository:</b>", table_cell_style), Paragraph("<a href='https://github.com/aravindkasarla5/annapurna-tiffin'>aravindkasarla5/annapurna-tiffin</a>", table_cell_style),
         Paragraph("<b>Primary Stack:</b>", table_cell_style), Paragraph("Node.js, Express.js, SPA JS, Vanilla CSS", table_cell_style)]
    ]
    meta_table = Table(meta_data, colWidths=[1.4*inch, 2.5*inch, 1.2*inch, 1.9*inch])
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), LIGHT_BG),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('INNERGRID', (0,0), (-1,-1), 0.5, BORDER_COLOR),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 12))

    # Section 1: System Overview & Key Features
    story.append(Paragraph("1. System Overview & Key Modules", h1_style))
    story.append(Paragraph(
        "Sri Lakshmi Annapurna Tiffin Center is a modern full-stack web application designed for online food ordering, "
        "live order tracking, payment verification, owner management, customer rewards, and review analytics. "
        "The system provides dedicated portals for both <b>Customers</b> and <b>Hotel Owners</b>.", body_style
    ))

    story.append(Paragraph("<b>Core Customer Portal Features:</b>", h2_style))
    story.append(Paragraph("• <b>Authentic Tiffin Ordering:</b> Interactive menu categorized by Breakfast, Lunch, Dinner, Snacks, and Daily Specials.", bullet_style))
    story.append(Paragraph("• <b>Live Order Status Tracking:</b> Real-time status sync (Received → Preparing → Ready → Completed → Rejected).", bullet_style))
    story.append(Paragraph("• <b>Interactive Payment Gateway:</b> Supports Cash on Delivery / Dine-in and Online UPI payments with shop owner QR scanner, UTR transaction verification, and manual receipt uploads.", bullet_style))
    story.append(Paragraph("• <b>Referral Rewards Program:</b> ₹30 first-order referral discount applied automatically via unique referral links or codes.", bullet_style))
    story.append(Paragraph("• <b>Persistent Session Security:</b> Continuous session authentication with local token persistence while preserving account history and past orders.", bullet_style))
    story.append(Paragraph("• <b>Customer Support & Live Chat:</b> Integrated ticket creation and real-time support messaging.", bullet_style))

    story.append(Spacer(1, 6))
    story.append(Paragraph("<b>Core Hotel Owner Portal Features:</b>", h2_style))
    story.append(Paragraph("• <b>Real-Time Order Management Hub:</b> Filter orders by status, update preparation state, approve UPI payments, and print customer bills.", bullet_style))
    story.append(Paragraph("• <b>Live Tiffin Menu & Availability Control:</b> Instant 🟢 Open / 🔴 Closed store status toggle and item-by-item availability switches.", bullet_style))
    story.append(Paragraph("• <b>Customer Reviews & Ratings Hub:</b> KPI analytics (Average Star Rating, Total Reviews, Rating Distribution Bars), official owner response modal, and public visibility toggle.", bullet_style))
    story.append(Paragraph("• <b>UPI Payment & QR Settings:</b> Upload custom store UPI QR code image and specify UPI ID for instant customer scanning.", bullet_style))
    story.append(Paragraph("• <b>Analytics & Revenue Reports:</b> Daily sales summaries, top-selling tiffins breakdown, and payment method statistics.", bullet_style))

    story.append(Spacer(1, 10))

    # Section 2: Technical Architecture & Security
    story.append(Paragraph("2. Technical Architecture & Security", h1_style))
    story.append(Paragraph(
        "The application follows a clean Single Page Application (SPA) architecture on the client side coupled with a lightweight RESTful Express.js backend server.", body_style
    ))

    arch_data = [
        [Paragraph("<b>Layer</b>", table_header_style), Paragraph("<b>Technology & Implementation</b>", table_header_style)],
        [Paragraph("<b>Backend Server</b>", table_cell_style), Paragraph("Node.js (v18+) & Express.js REST API with CORS, Bearer Token Auth, and PostgreSQL pooling.", table_cell_style)],
        [Paragraph("<b>Database Layer</b>", table_cell_style), Paragraph("PostgreSQL Database (Render PostgreSQL) configured via <code>DATABASE_URL</code> environment variable with relational schemas and atomic counters.", table_cell_style)],
        [Paragraph("<b>Frontend UI</b>", table_cell_style), Paragraph("Vanilla JavaScript (<code>app.js</code> SPA controller), HTML5 semantic structure, FontAwesome 6 icons.", table_cell_style)],
        [Paragraph("<b>Styling System</b>", table_cell_style), Paragraph("Custom Vanilla CSS (<code>styles.css</code>) featuring modern dark glassmorphic design, HSL colors, responsive media queries across desktop, tablet, and mobile (320px–1200px+).", table_cell_style)],
        [Paragraph("<b>Session Security</b>", table_cell_style), Paragraph("Bearer token tracking in <code>db.tokens</code> with persistent account authentication across Customer and Owner sessions.", table_cell_style)]
    ]
    arch_table = Table(arch_data, colWidths=[1.8*inch, 5.2*inch])
    arch_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), PRIMARY),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('INNERGRID', (0,0), (-1,-1), 0.5, BORDER_COLOR),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(arch_table)

    story.append(Spacer(1, 10))

    # Section 3: Session Authentication Workflow
    story.append(Paragraph("3. Session Security & Persistence Rules", h1_style))
    story.append(Paragraph(
        "To ensure robust user security without interrupting active browsing, session management follows a strict rule set:", body_style
    ))
    story.append(Paragraph("1. <b>Continuous Authentication:</b> User sessions remain securely active until manual logout or explicit account changes.", bullet_style))
    story.append(Paragraph("2. <b>Token Storage:</b> Tokens are securely retained in local storage for instant account restoration across page refreshes.", bullet_style))
    story.append(Paragraph("3. <b>Background Sync:</b> Automatic 2-second background status updates synchronize live store status and order updates in real-time.", bullet_style))
    story.append(Paragraph("4. <b>Data Integrity:</b> Database records (orders, wallet balance, profile, payments) are permanently stored in <code>db.json</code> via atomic writes.", bullet_style))

    story.append(Spacer(1, 10))

    # Section 4: API Reference Table
    story.append(Paragraph("4. API Endpoints Reference", h1_style))
    
    api_data = [
        [Paragraph("<b>Method</b>", table_header_style), Paragraph("<b>Endpoint Path</b>", table_header_style), Paragraph("<b>Auth / Access</b>", table_header_style), Paragraph("<b>Description</b>", table_header_style)],
        [Paragraph("POST", table_cell_style), Paragraph("<code>/api/auth/register</code>", table_cell_style), Paragraph("Public", table_cell_style), Paragraph("Register new Customer account.", table_cell_style)],
        [Paragraph("POST", table_cell_style), Paragraph("<code>/api/auth/login</code>", table_cell_style), Paragraph("Public", table_cell_style), Paragraph("Authenticate User / Owner & return Bearer token.", table_cell_style)],
        [Paragraph("GET", table_cell_style), Paragraph("<code>/api/menu</code>", table_cell_style), Paragraph("Public / Optional Auth", table_cell_style), Paragraph("Fetch all tiffin items & availability status.", table_cell_style)],
        [Paragraph("POST", table_cell_style), Paragraph("<code>/api/orders</code>", table_cell_style), Paragraph("Customer Auth", table_cell_style), Paragraph("Submit new tiffin order with payment details.", table_cell_style)],
        [Paragraph("GET", table_cell_style), Paragraph("<code>/api/orders</code>", table_cell_style), Paragraph("Authenticated User", table_cell_style), Paragraph("Get customer orders or all hotel orders (Owner).", table_cell_style)],
        [Paragraph("PATCH", table_cell_style), Paragraph("<code>/api/orders/:id/status</code>", table_cell_style), Paragraph("Owner Auth", table_cell_style), Paragraph("Update order status (Preparing/Ready/Completed).", table_cell_style)],
        [Paragraph("GET", table_cell_style), Paragraph("<code>/api/reviews</code>", table_cell_style), Paragraph("Public / Owner Auth", table_cell_style), Paragraph("Fetch reviews & owner rating statistics.", table_cell_style)],
        [Paragraph("POST", table_cell_style), Paragraph("<code>/api/reviews/:id/reply</code>", table_cell_style), Paragraph("Owner Auth", table_cell_style), Paragraph("Post official hotel owner response to customer review.", table_cell_style)],
        [Paragraph("GET", table_cell_style), Paragraph("<code>/api/support</code>", table_cell_style), Paragraph("Authenticated User", table_cell_style), Paragraph("Fetch support tickets and live messaging history.", table_cell_style)]
    ]

    api_table = Table(api_data, colWidths=[0.8*inch, 2.2*inch, 1.4*inch, 2.6*inch])
    api_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), DARK_BG),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('INNERGRID', (0,0), (-1,-1), 0.5, BORDER_COLOR),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 5),
        ('RIGHTPADDING', (0,0), (-1,-1), 5),
    ]))
    story.append(api_table)

    story.append(Spacer(1, 10))

    # Section 5: Credentials & Access
    story.append(Paragraph("5. Default Credentials & Access Information", h1_style))

    cred_data = [
        [Paragraph("<b>Role</b>", table_header_style), Paragraph("<b>Mobile Identifier</b>", table_header_style), Paragraph("<b>Password</b>", table_header_style), Paragraph("<b>Permissions & Scope</b>", table_header_style)],
        [Paragraph("<b>Hotel Owner / Admin</b>", table_cell_style), Paragraph("<code>9392874900</code>", table_cell_style), Paragraph("<code>Kumar@9392</code>", table_cell_style), Paragraph("Full store management, menu edit, orders hub, review replies, revenue reports.", table_cell_style)],
        [Paragraph("<b>Customer Account</b>", table_cell_style), Paragraph("<code>9876543210</code>", table_cell_style), Paragraph("<code>Kumar@9392</code>", table_cell_style), Paragraph("Browse menu, add to cart, checkout, live order tracking, wallet redemption, review submission.", table_cell_style)]
    ]
    cred_table = Table(cred_data, colWidths=[1.6*inch, 1.4*inch, 1.4*inch, 2.6*inch])
    cred_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), ACCENT_GOLD),
        ('TEXTCOLOR', (0,0), (-1,0), colors.black),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('INNERGRID', (0,0), (-1,-1), 0.5, BORDER_COLOR),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(cred_table)

    story.append(Spacer(1, 14))

    # Section 6: Deployment & Maintenance
    story.append(Paragraph("6. Deployment & Maintenance Summary", h1_style))
    story.append(Paragraph("• <b>Local Environment Execution:</b> Run <code>npm start</code> inside project folder. Server listens on port 3000.", bullet_style))
    story.append(Paragraph("• <b>Production Cloud Deployment:</b> Live on Render.com automatically connected to GitHub <code>main</code> branch.", bullet_style))
    story.append(Paragraph("• <b>Live Website URL:</b> <a href='https://annapurna-tiffin-1.onrender.com'>https://annapurna-tiffin-1.onrender.com</a>", bullet_style))

    story.append(Spacer(1, 15))
    story.append(HRFlowable(width="100%", thickness=1, color=PRIMARY, spaceBefore=5, spaceAfter=10))
    story.append(Paragraph("<font color='#888888'>Document generated automatically by Advanced Coding Agent for Sri Lakshmi Annapurna Tiffin Center System.</font>", ParagraphStyle('FootNote', fontName='Helvetica-Oblique', fontSize=8, alignment=1)))

    doc.build(story, canvasmaker=NumberedCanvas)
    print("PDF build successful! Saved to:", output_pdf_path)

if __name__ == '__main__':
    build_pdf()
